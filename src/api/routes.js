import express from 'express';
import { analyzeDocument } from '../analyzer/analyzer.js';
import { publicConfig } from '../config.js';
import { diffCoverage, buildCoverageView, buildTimeline } from '../coverage/view.js';
import { coverageBadgeSvg, fieldsCsv, gapsCsv, operationsCsv, typesCsv } from '../coverage/export.js';
import { seedDemo } from '../demo/seed.js';
import { introspectEndpoint, schemaFromSdl } from '../schema/loader.js';
import { buildSchemaGraph } from '../schema/graph.js';
import { asyncHandler, badRequest, notFound, unauthorized } from '../utils/errors.js';
import { nowIso } from '../utils/id.js';
import { queryList, queryString } from '../utils/text.js';

/**
 * REST API для UI, CI и ручного управления.
 *
 * @param {{ config: any, repository: any, registry: any, logger: any }} deps
 */
export function createApiRouter({ config, repository, registry, logger }) {
  const router = express.Router();
  const admin = createAdminAuth(config);

  // ---------------------------------------------------------------------
  // Конфигурация и статистика
  // ---------------------------------------------------------------------

  router.get('/config', (req, res) => {
    res.json({
      ...publicConfig(config),
      activeSchemaId: repository.activeSchemaId,
      counts: {
        schemas: repository.schemas.size,
        runs: repository.runs.size,
      },
      time: nowIso(),
    });
  });

  router.get(
    '/stats',
    asyncHandler(async (req, res) => {
      const active = repository.getActiveSchema();
      const runs = [...repository.runs.values()];
      const scoped = active ? runs.filter((run) => run.schemaId === active.id) : runs;
      const merged = await repository.mergedCoverage(scoped.map((run) => run.runId));
      const view = buildCoverageView({ schema: active, coverage: merged, runs: scoped, includeFields: false });
      res.json({
        schema: view.schema,
        summary: view.summary,
        counts: {
          schemas: repository.schemas.size,
          runs: runs.length,
          scopedRuns: scoped.length,
          services: Object.keys(config.services).length,
        },
      });
    }),
  );

  // ---------------------------------------------------------------------
  // Схемы
  // ---------------------------------------------------------------------

  router.get(
    '/schema',
    asyncHandler(async (req, res) => {
      const requestedId = queryString(req.query.id);
      const service = queryString(req.query.service);
      let snapshot = requestedId ? repository.getSchema(requestedId) : repository.getActiveSchema();
      if (!snapshot && service) {
        snapshot = repository
          .listSchemas()
          .filter((item) => item.service === service)
          .map((item) => repository.getSchema(item.id))[0];
      }
      if (!snapshot) {
        res.json({ schema: null, activeSchemaId: repository.activeSchemaId, schemas: repository.listSchemas() });
        return;
      }
      res.json({
        schema: publicSchema(snapshot),
        active: snapshot.id === repository.activeSchemaId,
        activeSchemaId: repository.activeSchemaId,
        schemas: repository.listSchemas(),
      });
    }),
  );

  router.get('/schemas', (req, res) => {
    res.json({ items: repository.listSchemas(), activeSchemaId: repository.activeSchemaId });
  });

  router.post(
    '/schema/introspect',
    admin,
    asyncHandler(async (req, res) => {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const endpoint = String(body.endpoint || config.schema.introspectUrl || '').trim();
      if (!endpoint) {
        throw badRequest('Укажите endpoint GraphQL-сервера или задайте TARGET_GRAPHQL_URL');
      }
      const service = String(body.service || config.schema.introspectService || 'default');
      const headers = { ...config.schema.introspectHeaders, ...(body.headers || {}) };
      const { schema, sdl } = await introspectEndpoint({
        endpoint,
        headers,
        timeoutMs: config.proxy.timeoutMs,
      });
      const graph = buildSchemaGraph(schema);
      const snapshot = await repository.saveSchema({
        sdl,
        graph,
        source: 'introspection',
        endpoint,
        service,
        name: body.name || '',
      });
      registry.invalidate(snapshot.id);
      res.status(201).json({ schema: publicSchema(snapshot), active: true });
    }),
  );

  router.post(
    '/schema/sdl',
    admin,
    asyncHandler(async (req, res) => {
      const body = req.body;
      const sdl = typeof body === 'string' ? body : String(body?.sdl || '');
      if (!sdl.trim()) throw badRequest('Передайте SDL в поле sdl (JSON) или текстом (Content-Type: text/plain)');
      const service = String(body?.service || config.schema.introspectService || 'default');
      const name = String(body?.name || '');
      let parsed;
      try {
        parsed = schemaFromSdl(sdl);
      } catch (error) {
        throw badRequest(error?.message || 'Некорректный SDL');
      }
      const graph = buildSchemaGraph(parsed.schema);
      const snapshot = await repository.saveSchema({
        sdl: parsed.sdl || sdl,
        graph,
        source: 'sdl',
        endpoint: '',
        service,
        name,
      });
      registry.invalidate(snapshot.id);
      res.status(201).json({ schema: publicSchema(snapshot), active: true });
    }),
  );

  router.post(
    '/schema/:id/activate',
    admin,
    asyncHandler(async (req, res) => {
      const snapshot = await repository.activateSchema(req.params.id);
      registry.invalidate(snapshot.id);
      res.json({ schema: publicSchema(snapshot), active: true });
    }),
  );

  router.delete(
    '/schema/:id',
    admin,
    asyncHandler(async (req, res) => {
      const result = await repository.deleteSchema(req.params.id);
      registry.invalidate(req.params.id);
      res.json(result);
    }),
  );

  // ---------------------------------------------------------------------
  // Прогоны
  // ---------------------------------------------------------------------

  router.get('/runs', (req, res) => {
    const filters = filtersFromQuery(req.query);
    const result = repository.listRuns(filters);
    res.json({
      items: result.items.map(compactRun),
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      facets: buildFacets(repository),
    });
  });

  router.post(
    '/runs',
    admin,
    asyncHandler(async (req, res) => {
      const run = await repository.ensureRun({ ...(req.body || {}), source: 'api' });
      res.status(201).json({ run: compactRun(run) });
    }),
  );

  router.get(
    '/runs/:id',
    asyncHandler(async (req, res) => {
      const run = repository.getRun(req.params.id);
      if (!run) throw notFound(`Прогон ${req.params.id} не найден`);
      const coverage = await repository.getCoverage(run.runId);
      res.json({
        run: compactRun(run),
        coverageStats: coverage?.stats || null,
        tests: Object.entries(coverage?.tests || {}).map(([key, value]) => ({ key, ...value })),
        operations: Object.entries(coverage?.operations || {}).map(([key, value]) => ({ key, ...value })),
      });
    }),
  );

  router.patch(
    '/runs/:id',
    admin,
    asyncHandler(async (req, res) => {
      const run = await repository.updateRun(req.params.id, req.body || {});
      res.json({ run: compactRun(run) });
    }),
  );

  router.delete(
    '/runs/:id',
    admin,
    asyncHandler(async (req, res) => {
      res.json(await repository.deleteRun(req.params.id));
    }),
  );

  // ---------------------------------------------------------------------
  // Покрытие
  // ---------------------------------------------------------------------

  router.get(
    '/coverage',
    asyncHandler(async (req, res) => {
      const scope = await resolveScope({ req, repository });
      const includeFields = queryString(req.query.include) !== 'summary';
      const view = buildCoverageView({
        schema: scope.schema,
        coverage: scope.merged,
        runs: scope.runs,
        includeFields,
      });
      res.json(view);
    }),
  );

  router.get(
    '/coverage/type/:name',
    asyncHandler(async (req, res) => {
      const scope = await resolveScope({ req, repository });
      const view = buildCoverageView({ schema: scope.schema, coverage: scope.merged, runs: scope.runs, includeFields: true });
      const type = view.types.find((item) => item.name === req.params.name);
      if (!type) throw notFound(`Тип ${req.params.name} не найден в активной схеме`);
      res.json({
        type,
        schema: view.schema,
        summary: view.summary,
        runs: view.runs,
        related: relatedTypes(view, type.name),
      });
    }),
  );

  router.get(
    '/coverage/timeline',
    asyncHandler(async (req, res) => {
      const filters = filtersFromQuery(req.query);
      const active = repository.getActiveSchema();
      const runs = repository.listRuns({ ...filters, schemaId: filters.schemaId || active?.id, limit: 200 }).items;
      res.json({ points: buildTimeline(runs), runs: runs.length });
    }),
  );

  router.get(
    '/coverage/compare',
    asyncHandler(async (req, res) => {
      const baseRunId = queryString(req.query.base || req.query.baseRun);
      const headRunId = queryString(req.query.head || req.query.headRun);
      if (!baseRunId || !headRunId) throw badRequest('Укажите base и head (run id) для сравнения');
      const baseRun = repository.getRun(baseRunId);
      const headRun = repository.getRun(headRunId);
      if (!baseRun) throw notFound(`Прогон ${baseRunId} не найден`);
      if (!headRun) throw notFound(`Прогон ${headRunId} не найден`);
      const schema = repository.getSchema(headRun.schemaId || baseRun.schemaId) || repository.getActiveSchema();
      const [baseMerged, headMerged] = await Promise.all([
        repository.mergedCoverage([baseRun.runId]),
        repository.mergedCoverage([headRun.runId]),
      ]);
      const baseView = buildCoverageView({ schema, coverage: baseMerged, runs: [baseRun], includeFields: true });
      const headView = buildCoverageView({ schema, coverage: headMerged, runs: [headRun], includeFields: true });
      res.json(diffCoverage(baseView, headView));
    }),
  );

  router.get(
    '/coverage/gaps',
    asyncHandler(async (req, res) => {
      const scope = await resolveScope({ req, repository });
      const view = buildCoverageView({ schema: scope.schema, coverage: scope.merged, runs: scope.runs, includeFields: true });
      res.json({
        total: view.summary.fieldsTotal - view.summary.fieldsCovered,
        uncoveredFields: view.uncovered,
        summary: view.summary,
      });
    }),
  );

  router.get(
    '/coverage/export',
    asyncHandler(async (req, res) => {
      const scope = await resolveScope({ req, repository });
      const view = buildCoverageView({ schema: scope.schema, coverage: scope.merged, runs: scope.runs, includeFields: true });
      const what = queryString(req.query.what) || 'fields';
      const format = queryString(req.query.format) || 'csv';
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');

      if (format === 'json') {
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('content-disposition', `attachment; filename="coverage-${stamp}.json"`);
        res.send(JSON.stringify(view, null, 2));
        return;
      }

      const builders = { fields: fieldsCsv, types: typesCsv, operations: operationsCsv, gaps: gapsCsv };
      const builder = builders[what];
      if (!builder) throw badRequest(`Неизвестный набор для экспорта: ${what}`);
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="coverage-${what}-${stamp}.csv"`);
      res.send(builder(view));
    }),
  );

  router.get(
    '/coverage/badge',
    asyncHandler(async (req, res) => {
      const scope = await resolveScope({ req, repository });
      const view = buildCoverageView({ schema: scope.schema, coverage: scope.merged, runs: scope.runs, includeFields: false });
      const label = queryString(req.query.label) || 'coverage';
      const svg = coverageBadgeSvg({ label, percent: view.summary.fieldsPercent });
      res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
      res.setHeader('cache-control', 'no-cache');
      res.send(svg);
    }),
  );

  // ---------------------------------------------------------------------
  // Журнал исполнений
  // ---------------------------------------------------------------------

  router.get(
    '/executions',
    asyncHandler(async (req, res) => {
      const filters = {
        runId: queryString(req.query.run),
        service: queryString(req.query.service),
        type: queryString(req.query.type),
        status: queryString(req.query.status),
        test: queryString(req.query.test),
        q: queryString(req.query.q),
        from: queryString(req.query.from),
        to: queryString(req.query.to),
        limit: Number(req.query.limit) || 50,
        offset: Number(req.query.offset) || 0,
      };
      const result = await repository.listExecutions(filters);
      res.json(result);
    }),
  );

  router.get(
    '/executions/:id',
    asyncHandler(async (req, res) => {
      const record = await repository.getExecution(req.params.id);
      if (!record) throw notFound(`Запрос ${req.params.id} не найден`);
      res.json({ execution: record });
    }),
  );

  // ---------------------------------------------------------------------
  // Ingest: загрузка покрытия из CI без прокси
  // ---------------------------------------------------------------------

  router.post(
    '/ingest',
    admin,
    asyncHandler(async (req, res) => {
      const body = req.body || {};
      const queries = Array.isArray(body.queries) ? body.queries : [];
      if (queries.length === 0) throw badRequest('Передайте массив queries: [{ query, variables?, operationName? }]');
      if (queries.length > 5000) throw badRequest('Слишком много запросов за один ingest (максимум 5000)');

      const run = await repository.ensureRun({ ...(body.run || {}), source: 'ingest' });
      const schemaEntry = registry.get(run.schemaId || repository.activeSchemaId) || registry.getActive();
      if (!schemaEntry) throw badRequest('Нет активной схемы — загрузите SDL или выполните introspection');

      const defaultTest = body.test && (body.test.id || body.test.name)
        ? { key: String(body.test.id || body.test.name), name: String(body.test.name || body.test.id) }
        : { key: '', name: '' };

      let processed = 0;
      let invalid = 0;
      const failures = [];
      const touched = new Set();
      const at = nowIso();

      for (const item of queries) {
        const query = typeof item === 'string' ? item : item?.query;
        if (!query) {
          failures.push({ index: processed, message: 'Пустой query' });
          continue;
        }
        const analysis = analyzeDocument({
          query,
          schema: schemaEntry.schema,
          operationName: item?.operationName || null,
        });
        if (!analysis.parsed) {
          invalid += 1;
          failures.push({ index: processed, message: analysis.errors[0]?.message || 'Parse error' });
          processed += 1;
          continue;
        }
        const test = item?.test
          ? { key: String(item.test.id || item.test.name || ''), name: String(item.test.name || item.test.id || '') }
          : defaultTest;
        await repository.applyCoverage({
          run,
          analysis,
          test,
          ok: item?.ok !== false,
          parsed: true,
          at,
        });
        for (const field of analysis.fields) if (field.resolved && field.executed !== false) touched.add(field.key);
        processed += 1;
      }

      res.json({
        run: compactRun(run),
        processed,
        invalid,
        failures: failures.slice(0, 20),
        fieldsTouched: touched.size,
        coverage: (await repository.getCoverage(run.runId))?.stats || null,
      });
    }),
  );

  // ---------------------------------------------------------------------
  // Бэкап/восстановление состояния (актуально для эфемерного диска Render)
  // ---------------------------------------------------------------------

  router.get(
    '/state/export',
    admin,
    asyncHandler(async (req, res) => {
      const state = await repository.exportState();
      res.setHeader('content-disposition', `attachment; filename="graphql-coverage-state-${Date.now()}.json"`);
      res.json(state);
    }),
  );

  router.post(
    '/state/import',
    admin,
    asyncHandler(async (req, res) => {
      if (!req.body || typeof req.body !== 'object') throw badRequest('Ожидается JSON состояния');
      const result = await repository.importState(req.body);
      registry.invalidate();
      res.json(result);
    }),
  );

  // ---------------------------------------------------------------------
  // Демо-данные (только на пустом хранилище)
  // ---------------------------------------------------------------------

  router.post(
    '/demo/seed',
    admin,
    asyncHandler(async (req, res) => {
      const result = await seedDemo({ repository, logger });
      if (result.seeded) {
        res.status(201).json(result);
        return;
      }
      res.json(result);
    }),
  );

  return router;
}

function createAdminAuth(config) {
  const expected = config.auth.adminToken;
  return (req, res, next) => {
    if (!expected) return next();
    const provided = String(req.get('x-admin-token') || '');
    if (provided && provided === expected) return next();
    next(unauthorized('Требуется заголовок x-admin-token'));
  };
}

/** @param {any} snapshot */
function publicSchema(snapshot) {
  const graph = snapshot.graph || { types: [], edges: [], roots: {}, stats: {} };
  return {
    id: snapshot.id,
    name: snapshot.name,
    service: snapshot.service,
    source: snapshot.source,
    endpoint: snapshot.endpoint,
    createdAt: snapshot.createdAt,
    stats: graph.stats,
    roots: graph.roots,
    types: graph.types,
    edges: graph.edges,
    sdl: snapshot.sdl,
  };
}

/** @param {any} run */
function compactRun(run) {
  return {
    runId: run.runId,
    name: run.name,
    service: run.service,
    branch: run.branch,
    team: run.team,
    env: run.env,
    build: run.build,
    commit: run.commit,
    notes: run.notes,
    status: run.status,
    source: run.source,
    schemaId: run.schemaId,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    lastSeenAt: run.lastSeenAt,
    finishedAt: run.finishedAt,
    requests: run.requests,
    fieldsCovered: run.fieldsCovered,
    fieldsTotal: run.fieldsTotal,
    percent: run.percent,
  };
}

/** @param {any} repository */
function buildFacets(repository) {
  const runs = [...repository.runs.values()];
  const unique = (values) => [...new Set(values.filter(Boolean))].sort();
  return {
    branches: unique(runs.map((run) => run.branch)),
    teams: unique(runs.map((run) => run.team)),
    envs: unique(runs.map((run) => run.env)),
    services: unique(runs.map((run) => run.service)),
    statuses: unique(runs.map((run) => run.status)),
  };
}

/**
 * Определяет схему и набор прогонов для запросов покрытия.
 * @param {{ req: any, repository: any }} options
 */
async function resolveScope({ req, repository }) {
  const requestedSchemaId = queryString(req.query.schemaId);
  const explicitIds = [...queryList(req.query.runs), queryString(req.query.run)].filter(Boolean);

  let schema = requestedSchemaId ? repository.getSchema(requestedSchemaId) : null;
  let runs;

  if (explicitIds.length > 0) {
    runs = explicitIds.map((runId) => repository.getRun(runId)).filter(Boolean);
    if (runs.length === 0) throw notFound('Указанные прогоны не найдены');
    if (!schema) {
      schema =
        repository.getSchema(runs[0].schemaId) ||
        repository.getSchema(runs.find((run) => run.schemaId)?.schemaId) ||
        repository.getActiveSchema();
    }
  } else {
    schema = schema || repository.getActiveSchema();
    const filters = filtersFromQuery(req.query);
    runs = repository.listRuns({
      ...filters,
      schemaId: requestedSchemaId || schema?.id,
      limit: Math.min(Number(req.query.limitRuns) || 200, 500),
    }).items;
  }

  const merged = await repository.mergedCoverage(runs.map((run) => run.runId));
  return { schema, runs, merged };
}

function filtersFromQuery(query) {
  return {
    branch: queryString(query.branch),
    team: queryString(query.team),
    env: queryString(query.env),
    service: queryString(query.service),
    schemaId: queryString(query.schemaId),
    status: queryString(query.status),
    from: queryString(query.from),
    to: queryString(query.to),
    q: queryString(query.q),
    limit: Number(query.limit) || undefined,
    offset: Number(query.offset) || 0,
    order: queryString(query.order) === 'asc' ? 'asc' : 'desc',
  };
}

/**
 * Типы, связанные с данным (входящие/исходящие связи) — для drill-down.
 * @param {any} view
 * @param {string} typeName
 */
function relatedTypes(view, typeName) {
  const result = [];
  for (const type of view.types) {
    for (const field of type.fields || []) {
      if (type.name === typeName && field.namedType && field.namedType !== typeName) {
        result.push({ direction: 'out', type: field.namedType, via: field.name });
      } else if (field.namedType === typeName && type.name !== typeName) {
        result.push({ direction: 'in', type: type.name, via: field.name });
      }
    }
  }
  const seen = new Set();
  return result.filter((item) => {
    const key = `${item.direction}:${item.type}:${item.via}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
