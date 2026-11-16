import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { schemaFromSdl } from '../src/schema/loader.js';
import { DEMO_SDL, request, startMockUpstream, startTestApp } from './helpers.js';

async function setup({ upstreamUrl, seed = false, env = {} } = {}) {
  const ctx = await startTestApp({ seed, env: { TARGET_GRAPHQL_URL: upstreamUrl, ...env } });
  const { schema, graph } = schemaFromSdl(DEMO_SDL);
  await ctx.repository.saveSchema({ sdl: DEMO_SDL, graph, source: 'test', service: 'default' });
  ctx.schema = schema;
  return ctx;
}

const proxyBody = (query, extra = {}) => JSON.stringify({ query, ...extra });

test('проксирует запрос, прокидывает заголовки и считает покрытие', async (t) => {
  const upstream = await startMockUpstream({ body: { data: { ok: true } }, headers: { 'x-upstream': 'yes' } });
  const ctx = await setup({ upstreamUrl: upstream.url });
  t.after(async () => {
    await ctx.cleanup();
    await upstream.close();
  });

  const { response, json } = await request(ctx.base, '/proxy', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer client-token',
      'x-run-id': 'run-1',
      'x-branch': 'main',
      'x-team': 'qa',
      'x-environment': 'staging',
      'x-build-id': '77',
      'x-test-id': 't-1',
      'x-test-name': encodeURIComponent('Первый тест'),
    },
    body: proxyBody('query GetUser($id: ID!) { user(id: $id) { id name } }', { variables: { id: 'u1' } }),
  });

  assert.equal(response.status, 200);
  assert.equal(json.data.ok, true);
  assert.equal(response.headers.get('x-upstream'), 'yes');
  assert.equal(response.headers.get('x-coverage-proxy-run-id'), 'run-1');
  assert.equal(response.headers.get('x-coverage-proxy-valid'), 'yes');
  assert.equal(Number(response.headers.get('x-coverage-proxy-fields')), 3);

  const call = upstream.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['authorization'], 'Bearer client-token');
  assert.equal(call.headers['x-run-id'], undefined);
  assert.equal(call.headers['x-test-name'], undefined);
  assert.deepEqual(call.body.variables, { id: 'u1' });

  const execution = await ctx.repository.getExecution(response.headers.get('x-coverage-proxy-request-id'));
  assert.equal(execution.runId, 'run-1');
  assert.equal(execution.operationType, 'query');
  assert.equal(execution.status, 200);
  assert.equal(execution.test.key, 't-1');

  const coverage = await ctx.repository.getCoverage('run-1');
  assert.equal(coverage.fields['Query.user'].hits, 1);
  assert.equal(coverage.fields['User.name'].hits, 1);
  assert.equal(coverage.tests['t-1'].name, 'Первый тест');

  const run = ctx.repository.getRun('run-1');
  assert.equal(run.branch, 'main');
  assert.equal(run.build, '77');
  assert.equal(run.requests, 1);
});

test('поддерживает GET-запрос и raw application/graphql', async (t) => {
  const upstream = await startMockUpstream({ body: { data: { ok: true } } });
  const ctx = await setup({ upstreamUrl: upstream.url });
  t.after(async () => {
    await ctx.cleanup();
    await upstream.close();
  });

  const query = encodeURIComponent('{ users { id } }');
  const getResponse = await request(ctx.base, `/proxy?query=${query}&variables=${encodeURIComponent('{}')}`);
  assert.equal(getResponse.status, 200);
  assert.equal(upstream.calls.length, 1);

  const rawResponse = await request(ctx.base, '/proxy', {
    method: 'POST',
    headers: { 'content-type': 'application/graphql' },
    body: '{ user(id: "1") { id } }',
  });
  assert.equal(rawResponse.status, 200);
  assert.equal(upstream.calls.length, 2);
});

test('возвращает 502 и пишет ошибку в журнал, если upstream недоступен', async (t) => {
  const ctx = await setup({ upstreamUrl: 'http://127.0.0.1:1/graphql' });
  t.after(() => ctx.cleanup());

  const { response, json } = await request(ctx.base, '/proxy', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-run-id': 'run-down' },
    body: proxyBody('{ user(id: "1") { id } }'),
  });
  assert.equal(response.status, 502);
  assert.equal(json.errors[0].extensions.code, 'UPSTREAM_UNAVAILABLE');

  const list = await ctx.repository.listExecutions({ runId: 'run-down' });
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].status, 0);
  const coverage = await ctx.repository.getCoverage('run-down');
  assert.equal(coverage.errors, 1);
  assert.equal(coverage.fields['Query.user'].hits, 1);
});

test('strict-валидация не пропускает запрос к upstream', async (t) => {
  const upstream = await startMockUpstream({ body: { data: { ok: true } } });
  const ctx = await setup({ upstreamUrl: upstream.url, env: { PROXY_STRICT_VALIDATION: 'true' } });
  t.after(async () => {
    await ctx.cleanup();
    await upstream.close();
  });

  const { response, json } = await request(ctx.base, '/proxy', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-run-id': 'run-strict' },
    body: proxyBody('{ user(id: "1") { nope } }'),
  });
  assert.equal(response.status, 400);
  assert.ok(json.errors.length > 0);
  assert.equal(upstream.calls.length, 0);

  const list = await ctx.repository.listExecutions({ runId: 'run-strict' });
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].status, 400);
});

test('защита от SSRF: override и приватные адреса', async (t) => {
  const upstream = await startMockUpstream({ body: { data: { ok: true } } });
  const ctx = await setup({ upstreamUrl: upstream.url });
  t.after(async () => {
    await ctx.cleanup();
    await upstream.close();
  });

  const override = await request(ctx.base, '/proxy', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-target-url': 'http://127.0.0.1:9999/graphql' },
    body: proxyBody('{ users { id } }'),
  });
  assert.equal(override.status, 403);
  assert.match(override.json.error.message, /ALLOW_TARGET_OVERRIDE/);

  const privateCtx = await setup({ upstreamUrl: upstream.url, env: { ALLOW_PRIVATE_TARGETS: 'false' } });
  t.after(() => privateCtx.cleanup());
  const privateAttempt = await request(privateCtx.base, '/proxy', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: proxyBody('{ users { id } }'),
  });
  assert.equal(privateAttempt.status, 403);
});

test('API-ключ прокси и неизвестный сервис', async (t) => {
  const upstream = await startMockUpstream({ body: { data: { ok: true } } });
  const ctx = await setup({ upstreamUrl: upstream.url, env: { PROXY_API_KEY: 'secret-key' } });
  t.after(async () => {
    await ctx.cleanup();
    await upstream.close();
  });

  const unauthorized = await request(ctx.base, '/proxy', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: proxyBody('{ users { id } }'),
  });
  assert.equal(unauthorized.status, 401);

  const authorized = await request(ctx.base, '/proxy', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-proxy-key': 'secret-key' },
    body: proxyBody('{ users { id } }'),
  });
  assert.equal(authorized.status, 200);

  const unknownService = await request(ctx.base, '/proxy?service=missing', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-proxy-key': 'secret-key' },
    body: proxyBody('{ users { id } }'),
  });
  assert.equal(unknownService.status, 400);
});

test('batch-запросы и пустой query отклоняются', async (t) => {
  const upstream = await startMockUpstream({ body: { data: { ok: true } } });
  const ctx = await setup({ upstreamUrl: upstream.url });
  t.after(async () => {
    await ctx.cleanup();
    await upstream.close();
  });

  const batch = await request(ctx.base, '/proxy', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([{ query: '{ users { id } }' }]),
  });
  assert.equal(batch.status, 400);

  const empty = await request(ctx.base, '/proxy', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ variables: {} }),
  });
  assert.equal(empty.status, 400);
});

test('streaming SSE пробрасывается без буферизации', async (t) => {
  const sse = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"orderUpdated":1}\n\n');
      setTimeout(() => res.end('data: [DONE]\n\n'), 30);
    });
  });
  sse.listen(0, '127.0.0.1');
  await once(sse, 'listening');
  const ctx = await setup({ upstreamUrl: `http://127.0.0.1:${sse.address().port}/graphql` });
  t.after(async () => {
    await ctx.cleanup();
    await new Promise((resolve) => sse.close(resolve));
  });

  const response = await fetch(`${ctx.base}/proxy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-run-id': 'run-sse' },
    body: proxyBody('{ user(id: "1") { id } }'),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /event-stream/);
  const text = await response.text();
  assert.match(text, /orderUpdated/);

  await new Promise((resolve) => setTimeout(resolve, 120));
  const coverage = await ctx.repository.getCoverage('run-sse');
  assert.ok(coverage.fields['Query.user']);
});
