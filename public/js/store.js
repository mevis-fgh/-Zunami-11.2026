import { api } from './api.js';

export const FILTER_KEYS = ['run', 'branch', 'team', 'env', 'from', 'to', 'service', 'schemaId'];

export const state = {
  config: null,
  schema: null,
  schemas: [],
  activeSchemaId: '',
  coverage: null,
  runs: [],
  runTotal: 0,
  facets: { branches: [], teams: [], envs: [], services: [], statuses: [] },
  filters: {},
  baseLoaded: false,
  lastLoadedAt: 0,
};

/** @type {Map<string, any>} */
const cache = new Map();
const CACHE_TTL_MS = 60_000;

/** @param {URLSearchParams} params */
export function filtersFromParams(params) {
  /** @type {Record<string, string>} */
  const filters = {};
  for (const key of FILTER_KEYS) filters[key] = params.get(key) || '';
  return filters;
}

/**
 * @param {Record<string, string>} filters
 * @param {{ includeRun?: boolean }} [options]
 */
export function queryFromFilters(filters, { includeRun = true } = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filters || {})) {
    if (!value) continue;
    if (!includeRun && key === 'run') continue;
    search.set(key, value);
  }
  return search.toString();
}

export function hasActiveFilters() {
  return Boolean(
    state.filters.run || state.filters.branch || state.filters.team || state.filters.env || state.filters.from || state.filters.to,
  );
}

/** @param {boolean} [force] */
export async function ensureBase(force = false) {
  if (state.baseLoaded && !force) return;
  const [config, schemaResponse] = await Promise.all([api('/api/config'), api('/api/schema')]);
  state.config = config;
  Object.assign(state, {
    schema: schemaResponse.schema,
    schemas: schemaResponse.schemas || [],
    activeSchemaId: schemaResponse.activeSchemaId || '',
    baseLoaded: true,
  });
}

/**
 * @param {Record<string, string>} filters
 * @param {boolean} [force]
 */
export async function ensureData(filters, force = false) {
  state.filters = filters;
  const key = JSON.stringify(filters);
  const cached = cache.get(key);
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    apply(cached);
    return;
  }

  const coverageQuery = queryFromFilters(filters);
  const runsQuery = queryFromFilters(filters, { includeRun: false });
  const [coverage, runsResponse] = await Promise.all([
    api(`/api/coverage${coverageQuery ? `?${coverageQuery}` : ''}`),
    api(`/api/runs?${runsQuery ? `${runsQuery}&` : ''}limit=200`),
  ]);

  const entry = {
    coverage,
    runs: runsResponse.items || [],
    runTotal: runsResponse.total || 0,
    facets: runsResponse.facets || {},
    at: Date.now(),
  };
  cache.set(key, entry);
  apply(entry);
}

/** @param {any} entry */
function apply(entry) {
  state.coverage = entry.coverage;
  state.runs = entry.runs;
  state.runTotal = entry.runTotal;
  state.facets = mergeFacets(state.facets, entry.facets);
  state.lastLoadedAt = entry.at;
}

/** @param {any} previous @param {any} next */
function mergeFacets(previous, next) {
  const union = (a = [], b = []) => [...new Set([...a, ...b].filter(Boolean))].sort();
  return {
    branches: union(previous?.branches, next?.branches),
    teams: union(previous?.teams, next?.teams),
    envs: union(previous?.envs, next?.envs),
    services: union(previous?.services, next?.services),
    statuses: union(previous?.statuses, next?.statuses),
  };
}

export function invalidateAll() {
  cache.clear();
  state.baseLoaded = false;
  state.lastLoadedAt = 0;
}

/** @param {string} runId */
export function findRun(runId) {
  return state.runs.find((run) => run.runId === runId) || null;
}

export function sortedRuns() {
  return [...state.runs].sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
}

export function summary() {
  return (
    state.coverage?.summary || {
      fieldsTotal: 0,
      fieldsCovered: 0,
      fieldsPercent: 0,
      typesTotal: 0,
      typesCovered: 0,
      typesPercent: 0,
      argsTotal: 0,
      argsCovered: 0,
      argsPercent: 0,
      requests: 0,
      tests: 0,
      runs: 0,
      uncoveredFields: 0,
      maxDepth: 0,
      testCoverage: { tests: 0, fieldsCovered: 0, percent: 0 },
    }
  );
}

/** Все поля схемы плоским списком с именем типа. */
export function allFields() {
  const types = state.coverage?.types || [];
  return types.flatMap((type) => (type.fields || []).map((field) => ({ ...field, typeName: type.name, typeKind: type.kind })));
}

/** Группировка непокрытых полей по типам. */
export function uncoveredByType() {
  const groups = new Map();
  for (const field of allFields()) {
    if (field.covered) continue;
    const group = groups.get(field.typeName) || { typeName: field.typeName, fields: [] };
    group.fields.push(field);
    groups.set(field.typeName, group);
  }
  return [...groups.values()].sort((a, b) => b.fields.length - a.fields.length);
}

/** @param {string} runId */
export function runDelta(runId) {
  const runs = sortedRuns();
  const index = runs.findIndex((run) => run.runId === runId);
  if (index < 0 || index === runs.length - 1) return null;
  return Number((runs[index].percent - runs[index + 1].percent).toFixed(1));
}
