import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSchema } from 'graphql';
import { analyzeDocument } from '../src/analyzer/analyzer.js';
import { buildSchemaGraph } from '../src/schema/graph.js';
import {
  applyAnalysisToCoverage,
  blankCoverage,
  computeCoverageStats,
  mergeCoverage,
} from '../src/coverage/stats.js';
import { buildCoverageView, diffCoverage } from '../src/coverage/view.js';

const SDL = `
  type Query {
    user(id: ID!): User
    users: [User!]!
  }
  type User { id: ID! name: String! role: Role }
  type Admin { id: ID! }
  enum Role { ADMIN USER }
`;

const schema = buildSchema(SDL);
const graph = buildSchemaGraph(schema);
const snapshot = { id: 'sch_test', name: 'Test schema', service: 'default', createdAt: new Date().toISOString(), graph };

const analyze = (query) => analyzeDocument({ query, schema });

test('применяет анализ к агрегату: поля, типы, аргументы, тесты, операции', () => {
  const coverage = blankCoverage('run1', 'sch_test');
  applyAnalysisToCoverage({
    coverage,
    analysis: analyze('query Q { user(id: "1") { id name } }'),
    at: '2026-01-01T00:00:00.000Z',
    test: { key: 't1', name: 'Первый тест' },
  });

  assert.equal(coverage.requests, 1);
  assert.equal(coverage.fields['Query.user'].hits, 1);
  assert.equal(coverage.fields['Query.user'].depth, 1);
  assert.equal(coverage.fields['User.name'].depth, 2);
  assert.deepEqual(Object.keys(coverage.fields['User.name'].tests), ['t1']);
  assert.equal(coverage.args['Query.user.id'].hits, 1);
  assert.equal(coverage.types.User.hits, 2);
  assert.equal(coverage.operations['query Q'].count, 1);
  assert.equal(coverage.tests.t1.requests, 1);
  assert.equal(coverage.maxDepth, 2);
});

test('счётчики растут при повторных запросах, merge складывает прогоны', () => {
  const coverage = blankCoverage('run1', 'sch_test');
  const analysis = analyze('query Q { user(id: "1") { id } }');
  applyAnalysisToCoverage({ coverage, analysis, test: { key: 't1', name: 'T1' } });
  const second = applyAnalysisToCoverage({ coverage, analysis, test: { key: 't2', name: 'T2' } });

  assert.equal(coverage.fields['Query.user'].hits, 2);
  assert.deepEqual(Object.keys(coverage.fields['User.id'].tests).sort(), ['t1', 't2']);
  assert.deepEqual(second.newlyCovered, []);

  const other = blankCoverage('run2', 'sch_test');
  applyAnalysisToCoverage({ coverage: other, analysis: analyze('{ users { id } }'), test: { key: 't3', name: 'T3' } });

  const merged = mergeCoverage([coverage, other]);
  assert.equal(merged.requests, 3);
  assert.equal(merged.fields['Query.user'].hits, 2);
  assert.equal(merged.fields['Query.users'].hits, 1);
  assert.deepEqual(Object.keys(merged.tests).sort(), ['t1', 't2', 't3']);
});

test('computeCoverageStats считает проценты относительно схемы', () => {
  const coverage = blankCoverage('run1', 'sch_test');
  applyAnalysisToCoverage({ coverage, analysis: analyze('{ user(id: "1") { id name } }') });
  const stats = computeCoverageStats(coverage, graph);
  assert.equal(stats.fieldsTotal, graph.fieldKeys.length); // 6
  assert.equal(stats.fieldsCovered, 3);
  assert.equal(stats.fieldsPercent, 50);
  assert.equal(stats.argsTotal, 1);
  assert.equal(stats.argsPercent, 100);
  assert.equal(stats.typesTotal, graph.compositeTypes.length);
  assert.ok(stats.typesCovered >= 2);
});

test('buildCoverageView отдаёт статусы типов и полей', () => {
  const coverage = blankCoverage('run1', 'sch_test');
  applyAnalysisToCoverage({ coverage, analysis: analyze('{ user(id: "1") { id } }') });
  const view = buildCoverageView({ schema: snapshot, coverage, runs: [{ runId: 'run1', startedAt: '2026-01-01T00:00:00Z' }] });

  const user = view.types.find((type) => type.name === 'User');
  assert.equal(user.status, 'partial');
  assert.equal(user.fieldsCovered, 1);
  assert.equal(user.fieldsCount, 3);

  const admin = view.types.find((type) => type.name === 'Admin');
  assert.equal(admin.status, 'uncovered');

  const userId = view.fields.find((field) => field.key === 'User.id');
  assert.equal(userId.covered, true);
  assert.equal(userId.hits, 1);
  const userRole = view.fields.find((field) => field.key === 'User.role');
  assert.equal(userRole.covered, false);
  assert.ok(view.uncovered.some((gap) => gap.key === 'User.role'));
  assert.equal(view.summary.fieldsPercent, 33.3);
  assert.ok(view.topFields.length > 0);
});

test('diffCoverage показывает новые и потерянные поля', () => {
  const base = blankCoverage('base', 'sch_test');
  applyAnalysisToCoverage({ coverage: base, analysis: analyze('{ user(id: "1") { id } }') });
  const head = blankCoverage('head', 'sch_test');
  applyAnalysisToCoverage({ coverage: head, analysis: analyze('{ user(id: "1") { id name } users { id } }') });

  const baseView = buildCoverageView({ schema: snapshot, coverage: base, runs: [{ runId: 'base' }] });
  const headView = buildCoverageView({ schema: snapshot, coverage: head, runs: [{ runId: 'head' }] });
  const diff = diffCoverage(baseView, headView);

  assert.equal(diff.summary.basePercent, 33.3);
  assert.ok(diff.summary.headPercent > diff.summary.basePercent);
  assert.ok(diff.newlyCovered.some((item) => item.key === 'User.name'));
  assert.equal(diff.regressed.length, 0);
});

test('невалидные запросы увеличивают invalid, но не портят покрытие', () => {
  const coverage = blankCoverage('run1', 'sch_test');
  applyAnalysisToCoverage({
    coverage,
    analysis: analyze('{ user(id: "1") { nope } }'),
    parsed: true,
    ok: false,
  });
  assert.equal(coverage.invalid, 1);
  assert.equal(coverage.errors, 1);
  assert.equal(coverage.fields['User.nope'], undefined);
});
