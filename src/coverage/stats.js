import { nowIso } from '../utils/id.js';
import { round1 } from '../utils/text.js';

/**
 * Пустая агрегированная запись покрытия для прогона.
 * @param {string} runId
 * @param {string} [schemaId]
 */
export function blankCoverage(runId, schemaId = '') {
  const at = nowIso();
  return {
    runId,
    schemaId,
    createdAt: at,
    updatedAt: at,
    requests: 0,
    errors: 0,
    invalid: 0,
    operations: {},
    fields: {},
    types: {},
    args: {},
    inputs: {},
    tests: {},
    maxDepth: 0,
    stats: null,
  };
}

/**
 * Пересчитывает абсолютные метрики покрытия относительно конкретной схемы.
 * @param {any} coverage
 * @param {any} graph
 */
export function computeCoverageStats(coverage, graph) {
  const fieldKeys = graph?.fieldKeys || [];
  const argKeys = graph?.argKeys || [];
  const inputKeys = graph?.inputKeys || [];
  const compositeTypes = graph?.compositeTypes || [];

  let fieldsCovered = 0;
  for (const key of fieldKeys) if (coverage.fields?.[key]) fieldsCovered += 1;

  let fieldsCoveredByTests = 0;
  for (const key of fieldKeys) {
    const entry = coverage.fields?.[key];
    if (entry && entry.tests && Object.keys(entry.tests).length > 0) fieldsCoveredByTests += 1;
  }

  let argsCovered = 0;
  for (const key of argKeys) if (coverage.args?.[key]) argsCovered += 1;

  let inputsCovered = 0;
  for (const key of inputKeys) if (coverage.inputs?.[key]) inputsCovered += 1;

  let typesCovered = 0;
  for (const name of compositeTypes) if (coverage.types?.[name]) typesCovered += 1;

  const percent = (covered, total) => (total > 0 ? round1((covered * 100) / total) : 0);

  const stats = {
    fieldsTotal: fieldKeys.length,
    fieldsCovered,
    fieldsPercent: percent(fieldsCovered, fieldKeys.length),
    argsTotal: argKeys.length,
    argsCovered,
    argsPercent: percent(argsCovered, argKeys.length),
    inputsTotal: inputKeys.length,
    inputsCovered,
    inputsPercent: percent(inputsCovered, inputKeys.length),
    typesTotal: compositeTypes.length,
    typesCovered,
    typesPercent: percent(typesCovered, compositeTypes.length),
    fieldsCoveredByTests,
    testsPercent: percent(fieldsCoveredByTests, fieldKeys.length),
  };
  return stats;
}

/**
 * Применяет результат анализа одного запроса к агрегату покрытия прогона.
 * Мутирует переданный объект coverage и возвращает список впервые покрытых полей.
 *
 * @param {{
 *   coverage: any,
 *   analysis: any,
 *   at?: string,
 *   test?: { key?: string, name?: string },
 *   ok?: boolean,
 *   parsed?: boolean,
 * }} params
 */
export function applyAnalysisToCoverage({ coverage, analysis, at = nowIso(), test = {}, ok = true, parsed = true }) {
  const testKey = test.key || '';
  const testName = test.name || testKey;
  const newlyCovered = [];

  coverage.requests += 1;
  coverage.updatedAt = at;
  if (!parsed) coverage.invalid += 1;
  else if (analysis.errors?.some((error) => error.code === 'VALIDATION_ERROR')) coverage.invalid += 1;
  if (!ok) coverage.errors += 1;

  const bump = (map, key, extra = {}) => {
    const entry = map[key] || (map[key] = { hits: 0, tests: {}, ...extra });
    entry.hits += 1;
    if (testKey) entry.tests[testKey] = (entry.tests[testKey] || 0) + 1;
    return entry;
  };

  const executedFields = (analysis.fields || []).filter((field) => field.resolved && field.executed !== false);
  for (const field of executedFields) {
    const entry = bump(coverage.fields, field.key, { depth: 0, lastSeen: at });
    entry.depth = Math.max(entry.depth || 0, field.depth || 0);
    entry.lastSeen = at;
    if (!entry.firstSeen) entry.firstSeen = at;
    if (entry.hits === 1) newlyCovered.push(field.key);
    bump(coverage.types, field.type, { lastSeen: at });
  }

  for (const arg of (analysis.args || []).filter((item) => item.resolved && item.executed !== false)) {
    bump(coverage.args, arg.key, { lastSeen: at });
  }

  for (const input of (analysis.inputs || []).filter((item) => item.resolved && item.executed !== false)) {
    bump(coverage.inputs, input.key, { lastSeen: at });
  }

  for (const operation of (analysis.operations || []).filter((item) => item.executed)) {
    const entry = coverage.operations[operation.key] || (coverage.operations[operation.key] = {
      count: 0,
      type: operation.type,
      name: operation.name,
      maxDepth: 0,
    });
    entry.count += 1;
    entry.maxDepth = Math.max(entry.maxDepth || 0, operation.depth || 0);
    entry.lastSeen = at;
  }

  coverage.maxDepth = Math.max(coverage.maxDepth || 0, analysis.maxDepth || 0);

  if (testKey) {
    const entry = coverage.tests[testKey] || (coverage.tests[testKey] = {
      name: testName,
      requests: 0,
      firstSeen: at,
    });
    entry.requests += 1;
    entry.name = testName;
    entry.lastSeen = at;
  }

  return { newlyCovered };
}

/**
 * Объединяет покрытие нескольких прогонов в одну «схему глазами Бога».
 * @param {any[]} coverages
 */
export function mergeCoverage(coverages) {
  const merged = {
    requests: 0,
    errors: 0,
    invalid: 0,
    operations: {},
    fields: {},
    types: {},
    args: {},
    inputs: {},
    tests: {},
    maxDepth: 0,
    firstSeen: null,
    lastSeen: null,
  };

  for (const coverage of coverages) {
    if (!coverage) continue;
    merged.requests += coverage.requests || 0;
    merged.errors += coverage.errors || 0;
    merged.invalid += coverage.invalid || 0;
    merged.maxDepth = Math.max(merged.maxDepth, coverage.maxDepth || 0);

    for (const [key, entry] of Object.entries(coverage.fields || {})) {
      const target = merged.fields[key] || (merged.fields[key] = { hits: 0, tests: {}, depth: 0 });
      target.hits += entry.hits || 0;
      target.depth = Math.max(target.depth, entry.depth || 0);
      if (!target.firstSeen || (entry.firstSeen && entry.firstSeen < target.firstSeen)) target.firstSeen = entry.firstSeen;
      if (!target.lastSeen || (entry.lastSeen && entry.lastSeen > target.lastSeen)) target.lastSeen = entry.lastSeen;
      for (const [testKey, count] of Object.entries(entry.tests || {})) {
        target.tests[testKey] = (target.tests[testKey] || 0) + count;
      }
    }
    for (const [key, entry] of Object.entries(coverage.types || {})) {
      const target = merged.types[key] || (merged.types[key] = { hits: 0, tests: {} });
      target.hits += entry.hits || 0;
      for (const [testKey, count] of Object.entries(entry.tests || {})) {
        target.tests[testKey] = (target.tests[testKey] || 0) + count;
      }
    }
    for (const [key, entry] of Object.entries(coverage.args || {})) {
      const target = merged.args[key] || (merged.args[key] = { hits: 0, tests: {} });
      target.hits += entry.hits || 0;
      for (const [testKey, count] of Object.entries(entry.tests || {})) {
        target.tests[testKey] = (target.tests[testKey] || 0) + count;
      }
    }
    for (const [key, entry] of Object.entries(coverage.inputs || {})) {
      const target = merged.inputs[key] || (merged.inputs[key] = { hits: 0, tests: {} });
      target.hits += entry.hits || 0;
      for (const [testKey, count] of Object.entries(entry.tests || {})) {
        target.tests[testKey] = (target.tests[testKey] || 0) + count;
      }
    }
    for (const [key, entry] of Object.entries(coverage.operations || {})) {
      const target = merged.operations[key] || (merged.operations[key] = {
        count: 0,
        type: entry.type,
        name: entry.name,
        maxDepth: 0,
      });
      target.count += entry.count || 0;
      target.maxDepth = Math.max(target.maxDepth, entry.maxDepth || 0);
    }
    for (const [key, entry] of Object.entries(coverage.tests || {})) {
      const target = merged.tests[key] || (merged.tests[key] = {
        name: entry.name || key,
        requests: 0,
      });
      target.requests += entry.requests || 0;
      if (!target.firstSeen || (entry.firstSeen && entry.firstSeen < target.firstSeen)) target.firstSeen = entry.firstSeen;
      if (!target.lastSeen || (entry.lastSeen && entry.lastSeen > target.lastSeen)) target.lastSeen = entry.lastSeen;
    }
  }
  return merged;
}
