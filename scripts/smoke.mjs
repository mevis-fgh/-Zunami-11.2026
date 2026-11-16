#!/usr/bin/env node
/**
 * Дымовой тест: поднимает сервис с демо-данными и моковым GraphQL-бэкендом,
 * проверяет ключевые эндпоинты и проксирование.
 *
 *   node scripts/smoke.mjs
 *
 * Завершается с кодом 1, если что-то не работает.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { seedDemo } from '../src/demo/seed.js';
import { SchemaRegistry } from '../src/schema/registry.js';
import { Repository } from '../src/storage/repository.js';
import { createLogger } from '../src/utils/logger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, '.tmp-smoke');

await fs.rm(DATA_DIR, { recursive: true, force: true });

const upstreamCalls = [];
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    upstreamCalls.push({ url: req.url, body });
    res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'mock' });
    res.end(JSON.stringify({ data: { ok: true, seen: upstreamCalls.length } }));
  });
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const upstreamPort = upstream.address().port;

const config = loadConfig({
  ...process.env,
  DATA_DIR,
  LOG_LEVEL: 'silent',
  NODE_ENV: 'test',
  ALLOW_PRIVATE_TARGETS: 'true',
  TARGET_GRAPHQL_URL: `http://127.0.0.1:${upstreamPort}/graphql`,
  AUTO_INTROSPECT: 'false',
});
const logger = createLogger({ level: 'silent' });
const repository = await new Repository({ config, logger }).init();
await seedDemo({ repository, logger });
const registry = new SchemaRegistry({ repository, logger });
const app = createApp({ config, repository, registry, logger });
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const check = async (name, fn) => {
  try {
    const detail = await fn();
    console.log(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name} — ${error?.message || error}`);
  }
};

const get = async (url, options) => {
  const response = await fetch(`${base}${url}`, options);
  const text = await response.text();
  return { response, text, json: () => JSON.parse(text) };
};

await check('GET /healthz', async () => {
  const { response, json } = await get('/healthz');
  if (!response.ok) throw new Error(`status ${response.status}`);
  return `schema=${json().schema?.name}`;
});

await check('GET / (SPA shell)', async () => {
  const { response } = await get('/');
  if (!response.ok) throw new Error(`status ${response.status}`);
});

await check('GET /api/schema', async () => {
  const { response, json } = await get('/api/schema');
  if (!response.ok) throw new Error(`status ${response.status}`);
  const data = json();
  if (!data.schema?.types?.length) throw new Error('нет типов');
  return `${data.schema.types.length} types, ${data.schema.stats.fields} fields`;
});

await check('GET /api/coverage?include=summary', async () => {
  const { response, json } = await get('/api/coverage?include=summary');
  if (!response.ok) throw new Error(`status ${response.status}`);
  const data = json();
  return `${data.summary.fieldsPercent}% (${data.summary.fieldsCovered}/${data.summary.fieldsTotal})`;
});

await check('POST /proxy → upstream + coverage', async () => {
  const { response, json } = await get('/proxy', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-run-id': 'smoke-run',
      'x-test-id': 'smoke-test',
      'x-test-name': 'Smoke test',
      'x-branch': 'main',
      'x-team': 'qa',
      'x-environment': 'test',
    },
    body: JSON.stringify({ query: 'query Smoke { product(id: "1") { id title price } }' }),
  });
  if (!response.ok) throw new Error(`proxy status ${response.status}`);
  const payload = json();
  if (payload.data?.ok !== true) throw new Error('ответ не проброшен');
  if (upstreamCalls.length !== 1) throw new Error('upstream не вызван');
  if (response.headers.get('x-coverage-proxy-run-id') !== 'smoke-run') throw new Error('нет заголовка прогона');
  return 'forwarded';
});

await check('coverage по прогону smoke-run', async () => {
  const { response, json } = await get('/api/coverage?run=smoke-run');
  if (!response.ok) throw new Error(`status ${response.status}`);
  const data = json();
  if (data.summary.fieldsCovered < 3) throw new Error(`покрыто ${data.summary.fieldsCovered}`);
  if (data.tests.length !== 1) throw new Error('тест не записан');
  return `${data.summary.fieldsCovered} fields`;
});

await check('GET /api/executions?run=smoke-run', async () => {
  const { response, json } = await get('/api/executions?run=smoke-run');
  if (!response.ok) throw new Error(`status ${response.status}`);
  const data = json();
  if (data.items.length !== 1) throw new Error(`items=${data.items.length}`);
  const detail = await get(`/api/executions/${data.items[0].id}`);
  if (!detail.json().execution.query.includes('product')) throw new Error('нет текста запроса');
  return data.items[0].id;
});

await check('GET /api/coverage/export (csv)', async () => {
  const { response, text } = await get('/api/coverage/export?format=csv&what=fields');
  if (!response.ok) throw new Error(`status ${response.status}`);
  if (!text.includes('Type') || !text.includes('Field')) throw new Error('не CSV');
  return `${text.split('\r\n').length} строк`;
});

await check('GET /api/coverage/badge (svg)', async () => {
  const { response, text } = await get('/api/coverage/badge');
  if (!response.ok) throw new Error(`status ${response.status}`);
  if (!text.startsWith('<svg')) throw new Error('не SVG');
});

await check('GET /api/coverage/timeline', async () => {
  const { response, json } = await get('/api/coverage/timeline');
  if (!response.ok) throw new Error(`status ${response.status}`);
  const data = json();
  if (data.points.length < 4) throw new Error(`точек ${data.points.length}`);
  return `${data.points.length} прогонов`;
});

await check('GET /api/coverage/compare', async () => {
  const { response, json } = await get('/api/coverage/compare?base=ci-1001-baseline&head=ci-1004-extended');
  if (!response.ok) throw new Error(`status ${response.status}`);
  const data = json();
  if (typeof data.summary.deltaPercent !== 'number') throw new Error('нет delta');
  return `${data.summary.basePercent}% → ${data.summary.headPercent}%`;
});

await check('GET /api/runs', async () => {
  const { response, json } = await get('/api/runs?limit=10');
  if (!response.ok) throw new Error(`status ${response.status}`);
  const data = json();
  if (data.items.length < 4) throw new Error(`прогонов ${data.items.length}`);
  return `${data.items.length}/${data.total}`;
});

await check('POST /api/ingest', async () => {
  const { response, json } = await get('/api/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      run: { runId: 'ingest-run', branch: 'main', team: 'qa', env: 'ci' },
      test: { id: 'ingest-test', name: 'Ingest smoke' },
      queries: [{ query: 'query Ingest { me { id email } }' }],
    }),
  });
  if (!response.ok) throw new Error(`status ${response.status}: ${await response.text()}`);
  const data = json();
  if (data.processed !== 1) throw new Error('не обработан запрос');
  return `fieldsTouched=${data.fieldsTouched}`;
});

await check('GET /api/coverage/gaps', async () => {
  const { response, json } = await get('/api/coverage/gaps?include=summary');
  if (!response.ok) throw new Error(`status ${response.status}`);
  const data = json();
  if (!data.total) throw new Error('нет gap-ов');
  return `${data.total} непокрытых`;
});

await check('POST /api/schema/sdl (валидация)', async () => {
  const { response, json } = await get('/api/schema/sdl', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sdl: 'type Query { ping: String }', service: 'smoke' }),
  });
  if (response.status !== 201) throw new Error(`status ${response.status}: ${await response.text()}`);
  return json().schema.id;
});

console.log('');
console.log(failures === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failures})`);
await new Promise((resolve) => server.close(resolve));
await new Promise((resolve) => upstream.close(resolve));
process.exit(failures === 0 ? 0 : 1);
