import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { analyzeDocument } from '../src/analyzer/analyzer.js';
import { loadConfig } from '../src/config.js';
import { schemaFromSdl } from '../src/schema/loader.js';
import { JsonStore } from '../src/storage/json-store.js';
import { Repository } from '../src/storage/repository.js';
import { createLogger } from '../src/utils/logger.js';
import { DEMO_SDL } from './helpers.js';

const logger = createLogger({ level: 'silent' });
let counter = 0;

async function makeRepository() {
  counter += 1;
  const dir = path.join(process.cwd(), '.tmp-tests', `repo-${Date.now()}-${counter}`);
  await fs.rm(dir, { recursive: true, force: true });
  const config = loadConfig({
    PATH: process.env.PATH,
    DATA_DIR: dir,
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
    AUTO_INTROSPECT: 'false',
  });
  const repository = await new Repository({ config, logger }).init();
  return { repository, config, dir, async cleanup() { await fs.rm(dir, { recursive: true, force: true }); } };
}

async function seedSchema(repository) {
  const { schema, graph } = schemaFromSdl(DEMO_SDL);
  const snapshot = await repository.saveSchema({
    sdl: DEMO_SDL,
    graph,
    source: 'test',
    service: 'default',
    name: 'Test',
  });
  return { snapshot, schema, graph };
}

test('JsonStore: запись, чтение, append-only журнал и защита от path traversal', async (t) => {
  const dir = path.join(process.cwd(), '.tmp-tests', `store-${Date.now()}`);
  await fs.rm(dir, { recursive: true, force: true });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new JsonStore({ dir, logger });

  await store.mkdir('nested');
  assert.equal(await store.read('nested/missing.json'), undefined);
  assert.deepEqual(await store.read('nested/missing.json', { fallback: true }), { fallback: true });

  await store.write('nested/item.json', { value: 42 });
  assert.deepEqual(await store.read('nested/item.json'), { value: 42 });

  await store.appendLine('nested/log.jsonl', { a: 1 });
  await store.appendLine('nested/log.jsonl', { a: 2 });
  assert.deepEqual(await store.readLines('nested/log.jsonl'), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(await store.listDir('nested'), ['item.json', 'log.jsonl']);

  assert.throws(() => store.resolve('../../evil.json'), /data-dir/);
  await assert.rejects(() => store.write('../evil.json', {}), /data-dir/);
});

test('JsonStore: параллельные записи сериализуются и файл остаётся валидным', async (t) => {
  const dir = path.join(process.cwd(), '.tmp-tests', `store-${Date.now()}-q`);
  await fs.rm(dir, { recursive: true, force: true });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new JsonStore({ dir, logger });

  await Promise.all(
    Array.from({ length: 25 }, (_, index) => store.write('race.json', { index })),
  );
  const value = await store.read('race.json');
  assert.ok(typeof value.index === 'number');
});

test('repository: снапшоты схем дедуплицируются и активируются', async (t) => {
  const { repository, cleanup } = await makeRepository();
  t.after(cleanup);
  const { snapshot } = await seedSchema(repository);

  assert.equal(repository.listSchemas().length, 1);
  assert.equal(repository.getActiveSchema().id, snapshot.id);

  const again = await repository.saveSchema({
    sdl: DEMO_SDL,
    graph: snapshot.graph,
    source: 'test',
    service: 'default',
  });
  assert.equal(again.id, snapshot.id);
  assert.equal(repository.listSchemas().length, 1);

  const { graph } = schemaFromSdl('type Query { ping: String }');
  const other = await repository.saveSchema({ sdl: 'type Query { ping: String }', graph, source: 'test' });
  assert.notEqual(other.id, snapshot.id);
  assert.equal(repository.getActiveSchema().id, other.id);
  await repository.activateSchema(snapshot.id);
  assert.equal(repository.getActiveSchema().id, snapshot.id);
});

test('repository: прогоны и авто-идентификаторы', async (t) => {
  const { repository, cleanup } = await makeRepository();
  t.after(cleanup);
  await seedSchema(repository);

  await assert.rejects(() => repository.ensureRun({ runId: '../hack' }), (error) => error.status === 400);

  const run = await repository.ensureRun({ branch: 'main', env: 'staging', service: 'default' });
  assert.match(run.runId, /^auto-staging-main-default-\d{4}-\d{2}-\d{2}$/);
  assert.equal(run.schemaId, repository.getActiveSchema().id);

  const same = await repository.ensureRun({ branch: 'main', env: 'staging', service: 'default' });
  assert.equal(same.runId, run.runId);

  const explicit = await repository.ensureRun({ runId: 'ci-42', branch: 'release/1.2', team: 'qa', build: '42' });
  assert.equal(explicit.runId, 'ci-42');
  assert.equal(explicit.branch, 'release/1.2');

  const list = repository.listRuns({ branch: 'release/1.2' });
  assert.equal(list.total, 1);
  assert.equal(list.items[0].runId, 'ci-42');

  await repository.updateRun('ci-42', { status: 'finished', notes: 'done' });
  assert.equal(repository.getRun('ci-42').status, 'finished');
  assert.ok(repository.getRun('ci-42').finishedAt);
});

test('repository: покрытие обновляется по запросам и агрегируется', async (t) => {
  const { repository, cleanup } = await makeRepository();
  t.after(cleanup);
  const { schema } = await seedSchema(repository);

  const run = await repository.ensureRun({ runId: 'run-a', branch: 'main' });
  const analysis = analyzeDocument({ query: 'query Q { user(id: "1") { id name } }', schema });
  await repository.applyCoverage({ run, analysis, test: { key: 't1', name: 'T1' } });

  const coverage = await repository.getCoverage('run-a');
  assert.equal(coverage.fields['User.name'].hits, 1);
  assert.equal(run.requests, 1);
  assert.equal(run.fieldsTotal, 6);
  assert.equal(run.fieldsCovered, 3);
  assert.equal(run.percent, 50);

  await repository.applyCoverage({ run, analysis, test: { key: 't1', name: 'T1' } });
  assert.equal((await repository.getCoverage('run-a')).fields['User.name'].hits, 2);
  assert.equal(run.percent, 50);

  const merged = await repository.mergedCoverage(['run-a']);
  assert.equal(merged.requests, 2);
  assert.equal(merged.tests.t1.requests, 2);

  await repository.deleteRun('run-a');
  assert.equal(await repository.getCoverage('run-a'), null);
  assert.equal(repository.getRun('run-a'), null);
});

test('repository: журнал исполнений, фильтры и получение по id', async (t) => {
  const { repository, cleanup } = await makeRepository();
  t.after(cleanup);
  await seedSchema(repository);
  const run = await repository.ensureRun({ runId: 'run-log' });

  await repository.recordExecution({
    id: 'req_1',
    at: new Date().toISOString(),
    runId: run.runId,
    service: 'default',
    operationType: 'query',
    operationName: 'Q',
    status: 200,
    ok: true,
    durationMs: 12,
    query: 'query Q { user(id:"1"){ id } }',
    test: { key: 't1', name: 'Test 1' },
    analysis: { fieldCount: 2, fields: ['Query.user', 'User.id'], valid: true },
  });
  await repository.recordExecution({
    id: 'req_2',
    at: new Date().toISOString(),
    runId: run.runId,
    service: 'default',
    operationType: 'mutation',
    status: 500,
    ok: false,
    durationMs: 40,
    query: 'mutation M { updateUser(id:"1"){ id } }',
    test: { key: 't2', name: 'Test 2' },
    analysis: { fieldCount: 1, fields: [], valid: false },
  });

  const all = await repository.listExecutions({ runId: 'run-log' });
  assert.equal(all.items.length, 2);
  assert.equal(all.items[0].id, 'req_2'); // новые сверху

  const errors = await repository.listExecutions({ runId: 'run-log', status: 'error' });
  assert.equal(errors.items.length, 1);
  assert.equal(errors.items[0].id, 'req_2');

  const found = await repository.getExecution('req_1');
  assert.equal(found.operationName, 'Q');
  assert.equal(await repository.getExecution('nope'), null);

  const byTest = await repository.listExecutions({ test: 'Test 1' });
  assert.equal(byTest.items.length, 1);
});

test('repository: экспорт/импорт состояния', async (t) => {
  const first = await makeRepository();
  const second = await makeRepository();
  t.after(first.cleanup);
  t.after(second.cleanup);

  const { schema, snapshot } = await seedSchema(first.repository);
  const run = await first.repository.ensureRun({ runId: 'run-export' });
  await first.repository.applyCoverage({
    run,
    analysis: analyzeDocument({ query: '{ users { name } }', schema }),
    test: { key: 't', name: 'T' },
  });

  const state = await first.repository.exportState();
  const result = await second.repository.importState(state);
  assert.equal(result.schemas, 1);
  assert.equal(result.runs, 1);
  assert.equal(second.repository.getActiveSchema().id, snapshot.id);
  assert.equal((await second.repository.getCoverage('run-export')).fields['Query.users'].hits, 1);
});
