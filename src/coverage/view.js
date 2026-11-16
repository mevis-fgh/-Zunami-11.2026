import { round1 } from '../utils/text.js';
import { computeCoverageStats } from './stats.js';

const OUTPUT_KINDS = new Set(['OBJECT', 'INTERFACE']);

/** @param {string} typeString */
export function baseTypeName(typeString) {
  return String(typeString || '').replace(/[\[\]!\s]/g, '');
}

/**
 * Собирает полное представление покрытия для UI/API:
 * сводка, типы с полями, аргументы, операции, тесты, «дыры».
 *
 * @param {{
 *   schema: any,
 *   coverage: any,
 *   runs?: any[],
 *   includeFields?: boolean,
 *   maxUncovered?: number,
 * }} options
 */
export function buildCoverageView({ schema, coverage, runs = [], includeFields = true, maxUncovered = 1000 }) {
  const graph = schema?.graph;
  if (!graph) {
    return {
      schema: null,
      summary: {
        fieldsTotal: 0, fieldsCovered: 0, fieldsPercent: 0,
        typesTotal: 0, typesCovered: 0, typesPercent: 0,
        argsTotal: 0, argsCovered: 0, argsPercent: 0,
        inputsTotal: 0, inputsCovered: 0, inputsPercent: 0,
        requests: 0, errors: 0, invalid: 0, tests: 0, runs: runs.length,
        maxDepth: 0, operations: 0, uncoveredFields: 0,
        testCoverage: { tests: 0, fieldsCovered: 0, percent: 0 },
      },
      types: [],
      fields: [],
      topFields: [],
      uncovered: [],
      operations: [],
      inputs: [],
      tests: [],
      runs: [],
      generatedAt: new Date().toISOString(),
    };
  }

  const stats = computeCoverageStats(coverage, graph);
  const fieldDefs = new Map();
  const argDefs = new Map();
  for (const type of graph.types) {
    for (const field of type.fields || []) {
      fieldDefs.set(`${type.name}.${field.name}`, field);
      for (const arg of field.args || []) {
        argDefs.set(`${type.name}.${field.name}.${arg.name}`, { ...arg, namedType: baseTypeName(arg.type) });
      }
    }
  }

  /** Типы, которые «затронуты» трафиком: сам тип, тип возвращаемого поля, тип аргумента. */
  const touchedTypes = new Set();
  for (const key of Object.keys(coverage.fields || {})) {
    const typeName = key.split('.')[0];
    touchedTypes.add(typeName);
    const def = fieldDefs.get(key);
    if (def) touchedTypes.add(def.namedType);
  }
  for (const key of Object.keys(coverage.args || {})) {
    const def = argDefs.get(key);
    if (def?.namedType) touchedTypes.add(def.namedType);
  }
  for (const key of Object.keys(coverage.inputs || {})) touchedTypes.add(key.split('.')[0]);

  const testFieldCounts = new Map();
  const flatFields = [];
  const types = [];

  for (const type of graph.types) {
    const typeCoverage = coverage.types?.[type.name];
    const base = {
      name: type.name,
      kind: type.kind,
      description: type.description || '',
      isRoot: Boolean(type.isRoot),
      interfaces: type.interfaces || [],
      possibleTypes: type.possibleTypes || [],
      hits: typeCoverage?.hits || 0,
      tests: typeCoverage?.tests || {},
      testCount: Object.keys(typeCoverage?.tests || {}).length,
    };

    if (OUTPUT_KINDS.has(type.kind)) {
      const fields = (type.fields || []).map((sourceField) => {
        const key = `${type.name}.${sourceField.name}`;
        const fieldCoverage = coverage.fields?.[key];
        const tests = fieldCoverage?.tests || {};
        for (const testKey of Object.keys(tests)) testFieldCounts.set(testKey, (testFieldCounts.get(testKey) || 0) + 1);
        const args = (sourceField.args || []).map((arg) => {
          const argKey = `${key}.${arg.name}`;
          const argCoverage = coverage.args?.[argKey];
          return {
            name: arg.name,
            type: arg.type,
            namedType: baseTypeName(arg.type),
            defaultValue: arg.defaultValue,
            description: arg.description || '',
            key: argKey,
            hits: argCoverage?.hits || 0,
            covered: Boolean(argCoverage),
            tests: argCoverage?.tests || {},
          };
        });
        return {
          name: sourceField.name,
          key,
          type: sourceField.type,
          namedType: sourceField.namedType,
          description: sourceField.description || '',
          deprecated: Boolean(sourceField.deprecated),
          deprecationReason: sourceField.deprecationReason,
          hits: fieldCoverage?.hits || 0,
          covered: Boolean(fieldCoverage),
          status: fieldCoverage ? 'covered' : 'uncovered',
          depth: fieldCoverage?.depth || 0,
          firstSeen: fieldCoverage?.firstSeen,
          lastSeen: fieldCoverage?.lastSeen,
          tests,
          testCount: Object.keys(tests).length,
          args,
          argsTotal: args.length,
          argsCovered: args.filter((arg) => arg.covered).length,
        };
      });

      const fieldsCovered = fields.filter((field) => field.covered).length;
      const percent = fields.length > 0 ? round1((fieldsCovered * 100) / fields.length) : 0;
      types.push({
        ...base,
        fields,
        fieldsCount: fields.length,
        fieldsCovered,
        percent,
        status: fields.length === 0 ? 'empty' : fieldsCovered === 0 ? 'uncovered' : fieldsCovered === fields.length ? 'covered' : 'partial',
      });
      for (const field of fields) flatFields.push(field);
    } else {
      const isTouched = touchedTypes.has(type.name);
      types.push({
        ...base,
        fields: [],
        fieldsCount: 0,
        fieldsCovered: 0,
        percent: isTouched ? 100 : 0,
        status: isTouched ? 'covered' : 'uncovered',
        values: type.values || [],
      });
    }
  }

  const tests = Object.entries(coverage.tests || {})
    .map(([key, entry]) => ({
      key,
      name: entry.name || key,
      requests: entry.requests || 0,
      fieldsCovered: testFieldCounts.get(key) || 0,
      firstSeen: entry.firstSeen,
      lastSeen: entry.lastSeen,
    }))
    .sort((a, b) => b.requests - a.requests);

  const operations = Object.entries(coverage.operations || {})
    .map(([key, entry]) => ({
      key,
      type: entry.type,
      name: entry.name,
      count: entry.count || 0,
      maxDepth: entry.maxDepth || 0,
      lastSeen: entry.lastSeen,
    }))
    .sort((a, b) => b.count - a.count);

  const inputs = graph.inputKeys.map((key) => {
    const [inputType, name] = key.split('.');
    const entry = coverage.inputs?.[key];
    return {
      key,
      inputType,
      name,
      hits: entry?.hits || 0,
      covered: Boolean(entry),
      tests: entry?.tests || {},
    };
  });

  const summary = {
    ...stats,
    requests: coverage.requests || 0,
    errors: coverage.errors || 0,
    invalid: coverage.invalid || 0,
    maxDepth: coverage.maxDepth || 0,
    operations: operations.length,
    tests: tests.length,
    runs: runs.length,
    uncoveredFields: Math.max(0, stats.fieldsTotal - stats.fieldsCovered),
    typesFullyCovered: types.filter((type) => type.status === 'covered' && type.fieldsCount > 0).length,
    typesPartial: types.filter((type) => type.status === 'partial').length,
    testCoverage: {
      tests: tests.length,
      fieldsCovered: stats.fieldsCoveredByTests,
      percent: stats.testsPercent,
    },
  };

  const topFields = flatFields
    .filter((field) => field.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 25)
    .map((field) => ({ key: field.key, type: field.key.split('.')[0], name: field.name, hits: field.hits, tests: field.testCount }));

  const uncovered = flatFields
    .filter((field) => !field.covered)
    .sort((a, b) => a.key.localeCompare(b.key))
    .slice(0, maxUncovered)
    .map((field) => ({ key: field.key, type: field.key.split('.')[0], name: field.name, typeRef: field.type, deprecated: field.deprecated }));

  return {
    schema: {
      id: schema.id,
      name: schema.name,
      service: schema.service,
      source: schema.source,
      endpoint: schema.endpoint,
      createdAt: schema.createdAt,
      stats: graph.stats,
      roots: graph.roots,
    },
    summary,
    types,
    fields: includeFields ? flatFields : [],
    topFields,
    uncovered,
    operations,
    inputs,
    tests,
    runs: runs.map((run) => ({
      runId: run.runId,
      name: run.name,
      branch: run.branch,
      team: run.team,
      env: run.env,
      build: run.build,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      requests: run.requests,
      percent: run.percent,
      schemaId: run.schemaId,
    })),
    scope: {
      runIds: runs.map((run) => run.runId),
      schemaId: schema.id,
      includeFields,
    },
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Сравнение двух представлений покрытия (before/after).
 * @param {any} base
 * @param {any} head
 */
export function diffCoverage(base, head) {
  const baseFields = new Map((base.fields || []).map((field) => [field.key, field]));
  const headFields = new Map((head.fields || []).map((field) => [field.key, field]));
  const allKeys = new Set([...baseFields.keys(), ...headFields.keys()]);

  const newlyCovered = [];
  const regressed = [];
  const changed = [];
  const stillUncovered = [];

  for (const key of allKeys) {
    const before = baseFields.get(key);
    const after = headFields.get(key);
    if (!before || !after) continue;
    if (!before.covered && after.covered) newlyCovered.push({ key, hitsBefore: before.hits, hitsAfter: after.hits });
    else if (before.covered && !after.covered) regressed.push({ key, hitsBefore: before.hits, hitsAfter: after.hits });
    else if (!before.covered && !after.covered) stillUncovered.push({ key });
    else if (before.hits !== after.hits) {
      changed.push({ key, hitsBefore: before.hits, hitsAfter: after.hits, delta: after.hits - before.hits });
    }
  }

  const sortKeys = (items) => items.sort((a, b) => a.key.localeCompare(b.key));
  sortKeys(newlyCovered);
  sortKeys(regressed);
  sortKeys(stillUncovered);
  changed.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return {
    summary: {
      basePercent: base.summary?.fieldsPercent || 0,
      headPercent: head.summary?.fieldsPercent || 0,
      deltaPercent: round1((head.summary?.fieldsPercent || 0) - (base.summary?.fieldsPercent || 0)),
      baseCovered: base.summary?.fieldsCovered || 0,
      headCovered: head.summary?.fieldsCovered || 0,
      newlyCovered: newlyCovered.length,
      regressed: regressed.length,
      stillUncovered: stillUncovered.length,
      fieldsTotal: head.summary?.fieldsTotal || 0,
    },
    base: { runIds: base.scope?.runIds || [], percent: base.summary?.fieldsPercent || 0 },
    head: { runIds: head.scope?.runIds || [], percent: head.summary?.fieldsPercent || 0 },
    newlyCovered: newlyCovered.slice(0, 500),
    regressed: regressed.slice(0, 500),
    changed: changed.slice(0, 200),
    stillUncovered: stillUncovered.slice(0, 500),
  };
}

/**
 * Timeline: точки по прогонам (для графика прогресса).
 * @param {any[]} runs
 */
export function buildTimeline(runs) {
  return runs
    .filter((run) => run.startedAt)
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
    .map((run) => ({
      runId: run.runId,
      name: run.name,
      branch: run.branch,
      team: run.team,
      env: run.env,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      percent: run.percent || 0,
      fieldsCovered: run.fieldsCovered || 0,
      fieldsTotal: run.fieldsTotal || 0,
      requests: run.requests || 0,
    }));
}
