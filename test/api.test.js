import assert from 'node:assert/strict';
import test from 'node:test';
import { request, startTestApp } from './helpers.js';

async function demoApp(t, env = {}) {
  const ctx = await startTestApp({ seed: true, env });
  t.after(() => ctx.cleanup());
  return ctx;
}

test('healthz и публичная конфигурация не раскрывают секреты', async (t) => {
  const ctx = await demoApp(t, { PROXY_API_KEY: 'super-secret', ADMIN_TOKEN: 'admin-secret' });

  const health = await request(ctx.base, '/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.json.status, 'ok');
  assert.equal(health.json.schema.name.includes('Demo Shop'), true);

  const config = await request(ctx.base, '/api/config');
  assert.equal(config.status, 200);
  assert.equal(config.json.proxy.authRequired, true);
  assert.equal(JSON.stringify(config.json).includes('super-secret'), false);
  assert.equal(config.json.services.default.configured, false);
});

test('схема: активный снапшот, список, граф и SDL', async (t) => {
  const ctx = await demoApp(t);

  const schema = await request(ctx.base, '/api/schema');
  assert.equal(schema.status, 200);
  assert.ok(schema.json.schema.types.length > 10);
  assert.ok(schema.json.schema.edges.length > 10);
  assert.ok(schema.json.schema.stats.fields > 100);
  assert.equal(schema.json.active, true);
  assert.ok(schema.json.schema.sdl.includes('type Query'));

  const list = await request(ctx.base, '/api/schemas');
  assert.equal(list.status, 200);
  assert.equal(list.json.items.length, 1);
  assert.equal(list.json.items[0].active, true);
});

test('покрытие: сводка, срез по прогону, типы, timeline, compare, gaps', async (t) => {
  const ctx = await demoApp(t);

  const summary = await request(ctx.base, '/api/coverage?include=summary');
  assert.equal(summary.status, 200);
  assert.equal(summary.json.summary.fieldsTotal, 132);
  assert.equal(summary.json.summary.fieldsCovered, 104);
  assert.equal(summary.json.summary.fieldsPercent, 78.8);
  assert.equal(summary.json.summary.runs, 4);
  assert.equal(summary.json.summary.tests, 18);
  assert.equal(summary.json.fields.length, 0);

  const scoped = await request(ctx.base, '/api/coverage?run=ci-1001-baseline');
  assert.equal(scoped.status, 200);
  assert.equal(scoped.json.summary.fieldsPercent, 31.1);
  assert.equal(scoped.json.runs.length, 1);

  const type = await request(ctx.base, '/api/coverage/type/Order');
  assert.equal(type.status, 200);
  assert.equal(type.json.type.name, 'Order');
  assert.ok(type.json.type.fields.length > 5);
  assert.ok(Array.isArray(type.json.related));

  const missingType = await request(ctx.base, '/api/coverage/type/NoSuchType');
  assert.equal(missingType.status, 404);

  const timeline = await request(ctx.base, '/api/coverage/timeline');
  assert.equal(timeline.status, 200);
  assert.equal(timeline.json.points.length, 4);
  assert.equal(timeline.json.points[0].percent, 31.1);
  assert.equal(timeline.json.points[3].percent, 78.8);

  const compare = await request(ctx.base, '/api/coverage/compare?base=ci-1001-baseline&head=ci-1004-extended');
  assert.equal(compare.status, 200);
  assert.equal(compare.json.summary.deltaPercent, 47.7);
  assert.ok(compare.json.newlyCovered.length > 0);

  const badCompare = await request(ctx.base, '/api/coverage/compare?base=ci-1001-baseline&head=nope');
  assert.equal(badCompare.status, 404);

  const gaps = await request(ctx.base, '/api/coverage/gaps');
  assert.equal(gaps.status, 200);
  assert.ok(gaps.json.total > 0);
  assert.ok(gaps.json.uncoveredFields.some((gap) => gap.key === 'User.wishlist'));
});

test('экспорт CSV/JSON и SVG-бейдж', async (t) => {
  const ctx = await demoApp(t);

  const csv = await request(ctx.base, '/api/coverage/export?format=csv&what=fields');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.text, /"Type";"Field";"ReturnType"/);
  assert.ok(csv.text.split('\r\n').length > 100);

  const gapsCsv = await request(ctx.base, '/api/coverage/export?format=csv&what=gaps');
  assert.match(gapsCsv.text, /"User";"wishlist"/);

  const json = await request(ctx.base, '/api/coverage/export?format=json');
  assert.equal(json.status, 200);
  assert.ok(json.json.summary);

  const badge = await request(ctx.base, '/api/coverage/badge');
  assert.equal(badge.status, 200);
  assert.match(badge.headers.get('content-type'), /svg/);
  assert.match(badge.text, /78\.8%|79%/);
});

test('прогоны: список с фасетами, создание, правка, удаление', async (t) => {
  const ctx = await demoApp(t);

  const list = await request(ctx.base, '/api/runs?limit=10');
  assert.equal(list.status, 200);
  assert.equal(list.json.total, 4);
  assert.deepEqual(list.json.facets.branches.sort(), ['main', 'release/1.2']);
  assert.deepEqual(list.json.facets.envs.sort(), ['production', 'staging']);

  const filtered = await request(ctx.base, '/api/runs?branch=main');
  assert.equal(filtered.json.total, 2);

  const created = await request(ctx.base, '/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId: 'api-run', branch: 'feature/x', team: 'dev', env: 'dev' }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.run.runId, 'api-run');

  const patched = await request(ctx.base, '/api/runs/api-run', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'finished', notes: 'готово' }),
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.run.status, 'finished');

  const detail = await request(ctx.base, '/api/runs/api-run');
  assert.equal(detail.status, 200);
  assert.equal(detail.json.run.notes, 'готово');

  const removed = await request(ctx.base, '/api/runs/api-run', { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal((await request(ctx.base, '/api/runs/api-run')).status, 404);
});

test('журнал исполнений и drill-down до запроса', async (t) => {
  const ctx = await demoApp(t);

  const list = await request(ctx.base, '/api/executions?limit=10');
  assert.equal(list.status, 200);
  assert.equal(list.json.items.length, 10);

  const runScoped = await request(ctx.base, '/api/executions?run=ci-1001-baseline');
  assert.equal(runScoped.json.items.length, 4);
  assert.ok(runScoped.json.items.every((item) => item.runId === 'ci-1001-baseline'));

  const first = runScoped.json.items[0];
  const detail = await request(ctx.base, `/api/executions/${first.id}`);
  assert.equal(detail.status, 200);
  assert.ok(detail.json.execution.query.length > 0);
  assert.ok(detail.json.execution.analysis.fields.length > 0);

  const search = await request(ctx.base, '/api/executions?q=CreateOrder');
  assert.ok(search.json.items.length >= 1);

  assert.equal((await request(ctx.base, '/api/executions/nope')).status, 404);
});

test('ingest: загрузка покрытия из CI без прокси', async (t) => {
  const ctx = await demoApp(t);

  const response = await request(ctx.base, '/api/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      run: { runId: 'ci-ingest', branch: 'main', team: 'qa', env: 'ci', build: '900' },
      test: { id: 'smoke', name: 'Smoke' },
      queries: [
        { query: '{ me { id email } }' },
        { query: 'query Broken { user(id: "1") { nope } }' },
      ],
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.json.processed, 2);
  assert.ok(response.json.fieldsTouched >= 2);

  const coverage = await request(ctx.base, '/api/coverage?run=ci-ingest');
  assert.equal(coverage.json.summary.requests, 2);
  assert.equal(coverage.json.summary.invalid, 1);

  const empty = await request(ctx.base, '/api/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ queries: [] }),
  });
  assert.equal(empty.status, 400);
});

test('загрузка SDL переключает активную схему', async (t) => {
  const ctx = await demoApp(t);

  const upload = await request(ctx.base, '/api/schema/sdl', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sdl: 'type Query { ping: String }', name: 'Mini' }),
  });
  assert.equal(upload.status, 201);
  assert.equal(upload.json.schema.stats.fields, 1);

  const schema = await request(ctx.base, '/api/schema');
  assert.equal(schema.json.schema.name, 'Mini');
  assert.equal((await request(ctx.base, '/api/schemas')).json.items.length, 2);

  const coverage = await request(ctx.base, '/api/coverage');
  assert.equal(coverage.status, 200);
  assert.equal(coverage.json.summary.fieldsTotal, 1);

  const invalid = await request(ctx.base, '/api/schema/sdl', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sdl: 'type Query { broken: }' }),
  });
  assert.equal(invalid.status, 400);

  const activate = await request(ctx.base, `/api/schema/${ctx.repository.listSchemas()[1].id}/activate`, {
    method: 'POST',
  });
  assert.equal(activate.status, 200);
});

test('экспорт и импорт состояния', async (t) => {
  const ctx = await demoApp(t);

  const exported = await request(ctx.base, '/api/state/export');
  assert.equal(exported.status, 200);
  assert.equal(exported.json.schemas.length, 1);
  assert.equal(exported.json.runs.length, 4);
  assert.ok(exported.json.coverage.length >= 4);

  const imported = await request(ctx.base, '/api/state/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(exported.json),
  });
  assert.equal(imported.status, 200);
  assert.equal(imported.json.schemas, 1);
  assert.equal(imported.json.runs, 4);
});

test('демо-сидер на непустом хранилище не дублирует данные', async (t) => {
  const ctx = await demoApp(t);
  const response = await request(ctx.base, '/api/demo/seed', { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal(response.json.seeded, false);
});

test('admin token защищает изменяющие эндпоинты', async (t) => {
  const ctx = await demoApp(t, { ADMIN_TOKEN: 'top-secret' });

  const denied = await request(ctx.base, '/api/schema/sdl', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sdl: 'type Query { ping: String }' }),
  });
  assert.equal(denied.status, 401);

  const allowed = await request(ctx.base, '/api/schema/sdl', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': 'top-secret' },
    body: JSON.stringify({ sdl: 'type Query { pong: String }' }),
  });
  assert.equal(allowed.status, 201);

  const readAllowed = await request(ctx.base, '/api/coverage?include=summary');
  assert.equal(readAllowed.status, 200);
});

test('ошибки API: 404, битый JSON, CORS preflight', async (t) => {
  const ctx = await demoApp(t);

  const notFound = await request(ctx.base, '/api/nope');
  assert.equal(notFound.status, 404);
  assert.equal(notFound.json.error.code, 'NOT_FOUND');

  const badJson = await request(ctx.base, '/api/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ not json',
  });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.json.error.code, 'INVALID_JSON');

  const preflight = await request(ctx.base, '/api/coverage', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);
  assert.match(preflight.headers.get('access-control-allow-headers'), /x-run-id/);
});

test('SPA отдаёт index.html, статика доступна', async (t) => {
  const ctx = await demoApp(t);
  const shell = await request(ctx.base, '/');
  assert.equal(shell.status, 200);
  assert.match(shell.text, /Сеть глазами Бога/);

  const css = await request(ctx.base, '/assets/styles.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);

  const nested = await request(ctx.base, '/some/deep/route');
  assert.equal(nested.status, 200);
  assert.match(nested.text, /id="view"/);
});
