import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import express from 'express';
import { analyzeDocument, summarizeAnalysis } from '../analyzer/analyzer.js';
import { asyncHandler, badRequest } from '../utils/errors.js';
import { newId, nowIso } from '../utils/id.js';
import { queryString, sanitizeValue, truncateText } from '../utils/text.js';
import { resolveTarget } from './targets.js';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const TRACKING_HEADERS = new Set([
  'host',
  'content-length',
  'accept-encoding',
  'x-run-id',
  'x-branch',
  'x-git-branch',
  'x-team',
  'x-environment',
  'x-env',
  'x-build-id',
  'x-build-number',
  'x-commit',
  'x-test-id',
  'x-test-case',
  'x-test-name',
  'x-test-title',
  'x-service',
  'x-target-url',
  'x-proxy-key',
  'x-api-key',
]);

const DROP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
]);

/**
 * Прокси-слой: принимает GraphQL-запрос, анализирует его по схеме,
 * пробрасывает на целевой endpoint и обновляет покрытие.
 *
 * @param {{ config: any, repository: import('../storage/repository.js').Repository, registry: any, logger: any }} deps
 */
export function createProxyRouter({ config, repository, registry, logger }) {
  const router = express.Router();
  const auth = createProxyAuth(config);
  router.all(['/proxy', '/graphql'], auth, asyncHandler((req, res, next) => handleRequest({ req, res, next, config, repository, registry, logger })));
  return router;
}

/**
 * @param {any} config
 * @returns {import('express').RequestHandler}
 */
function createProxyAuth(config) {
  const expected = config.proxy.apiKey;
  return (req, res, next) => {
    if (!expected) return next();
    const provided = String(req.get('x-proxy-key') || req.get('x-api-key') || '');
    if (provided && safeEqual(provided, expected)) return next();
    res.status(401).json({
      errors: [{ message: 'Unauthorized: передайте x-proxy-key или x-api-key', extensions: { code: 'UNAUTHORIZED' } }],
    });
  };
}

/** @param {string} a @param {string} b */
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * @param {{ req: any, res: any, next: any, config: any, repository: any, registry: any, logger: any }} ctx
 */
async function handleRequest({ req, res, config, repository, registry, logger }) {
  if (!['POST', 'GET', 'PUT'].includes(req.method)) {
    res.status(405).json({ errors: [{ message: `Метод ${req.method} не поддерживается прокси` }] });
    return;
  }

  const requestId = newId('req');
  const startedAt = Date.now();

  const target = resolveTarget(config, req);
  const tracking = extractTracking(req, config, target.serviceName);
  const run = await repository.ensureRun(tracking.run);
  const payload = extractPayload(req);

  if (!payload.query || !payload.query.trim()) {
    throw badRequest('GraphQL-запрос пустой: ожидается поле query');
  }
  if (payload.query.length > config.proxy.maxQueryChars) {
    throw badRequest(`Запрос длиннее ${config.proxy.maxQueryChars} символов`);
  }

  const schemaEntry = registry.get(run.schemaId || repository.activeSchemaId) || registry.getActive();
  const analysis = analyzeDocument({
    query: payload.query,
    schema: schemaEntry?.schema || null,
    operationName: payload.operationName,
  });

  const executedOperations = analysis.operations.filter((operation) => operation.executed);
  const operationType = executedOperations.length > 0 ? executedOperations.map((operation) => operation.type).join(',') : analysis.operations[0]?.type || 'query';
  const operationName =
    payload.operationName || (executedOperations.length === 1 ? executedOperations[0].name : null) || null;

  const record = {
    id: requestId,
    at: nowIso(),
    runId: run.runId,
    service: target.serviceName,
    targetUrl: target.url,
    method: req.method,
    operationType,
    operationName,
    status: 0,
    ok: false,
    durationMs: 0,
    query: truncateText(payload.query, 8000),
    variables: sanitizeValue(payload.variables),
    test: tracking.test,
    client: {
      ip: req.ip || '',
      userAgent: String(req.get('user-agent') || '').slice(0, 200),
    },
    analysis: summarizeAnalysis(analysis),
    errors: analysis.errors.slice(0, 10),
    responsePreview: '',
    errorMessage: null,
  };

  if (config.proxy.strictValidation && analysis.parsed && !analysis.valid) {
    record.status = 400;
    record.durationMs = Date.now() - startedAt;
    record.errorMessage = 'Запрос не прошёл валидацию по схеме';
    await persist({ repository, logger, record, analysis, run, tracking, ok: false, parsed: true, countCoverage: false });
    res.status(400).json({
      errors: analysis.errors.map((error) => ({ message: error.message, extensions: { code: error.code, requestId } })),
    });
    return;
  }

  const headers = buildUpstreamHeaders(req, config, target.service);
  const forwardBody = JSON.stringify({
    query: payload.query,
    variables: payload.variables ?? undefined,
    operationName: payload.operationName || undefined,
  });

  let upstream;
  try {
    upstream = await fetch(target.url, {
      method: 'POST',
      headers,
      body: forwardBody,
      signal: AbortSignal.timeout(config.proxy.timeoutMs),
      redirect: 'manual',
    });
  } catch (error) {
    const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    const message = isTimeout ? `Upstream не ответил за ${config.proxy.timeoutMs} мс` : `Upstream недоступен: ${error?.message || error}`;
    record.status = 0;
    record.ok = false;
    record.errorMessage = message;
    record.durationMs = Date.now() - startedAt;
    await persist({ repository, logger, record, analysis, run, tracking, ok: false, parsed: analysis.parsed });
    res.status(502).json({
      errors: [{ message, extensions: { code: isTimeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE', requestId } }],
    });
    return;
  }

  const contentType = upstream.headers.get('content-type') || '';
  const isStreaming = /text\/event-stream|multipart\/mixed/i.test(contentType);
  const declaredLength = Number(upstream.headers.get('content-length') || 0);
  const mustStream = isStreaming || declaredLength > config.proxy.maxResponseBytes;

  res.status(upstream.status);
  for (const [name, value] of upstream.headers) {
    const lower = name.toLowerCase();
    if (DROP_RESPONSE_HEADERS.has(lower)) continue;
    try {
      res.setHeader(name, value);
    } catch {
      // небезопасный/неизвестный заголовок — пропускаем
    }
  }
  for (const [name, value] of Object.entries(config.proxy.extraResponseHeaders || {})) {
    try {
      res.setHeader(name, value);
    } catch {
      /* ignore */
    }
  }
  res.setHeader('x-coverage-proxy-request-id', requestId);
  res.setHeader('x-coverage-proxy-run-id', run.runId);
  res.setHeader('x-coverage-proxy-service', target.serviceName);
  res.setHeader('x-coverage-proxy-fields', String(record.analysis.fieldCount));
  res.setHeader('x-coverage-proxy-valid', analysis.valid ? 'yes' : 'no');

  record.status = upstream.status;
  record.ok = upstream.ok;

  if (mustStream && upstream.body) {
    record.responsePreview = '[streamed]';
    record.durationMs = Date.now() - startedAt;
    const stream = Readable.fromWeb(upstream.body);
    stream.on('error', (error) => logger.warn?.('proxy.stream_error', { requestId, message: error?.message }));
    res.on('close', () => {
      stream.destroy();
      persist({ repository, logger, record, analysis, run, tracking, ok: upstream.ok, parsed: analysis.parsed }).catch(() => {});
    });
    stream.pipe(res);
    return;
  }

  const buffer = Buffer.from(await upstream.arrayBuffer());
  record.durationMs = Date.now() - startedAt;
  record.responsePreview = truncateText(buffer.toString('utf8'), 1500);

  try {
    await persist({ repository, logger, record, analysis, run, tracking, ok: upstream.ok, parsed: analysis.parsed });
  } catch (error) {
    logger.error?.('proxy.persist_failed', { requestId, message: error?.message || String(error) });
  }

  if (buffer.length === 0) {
    res.end();
    return;
  }
  res.end(buffer);
}

/**
 * @param {{ repository: any, logger: any, record: any, analysis: any, run: any, tracking: any,
 *           ok: boolean, parsed: boolean, countCoverage?: boolean }} params
 */
async function persist({ repository, logger, record, analysis, run, tracking, ok, parsed, countCoverage = true }) {
  try {
    await repository.recordExecution(record);
  } catch (error) {
    logger.error?.('execution.persist_failed', { requestId: record.id, message: error?.message || String(error) });
  }
  if (!countCoverage) return;
  try {
    await repository.applyCoverage({
      run,
      analysis,
      test: tracking.test,
      ok,
      parsed,
      at: record.at,
    });
  } catch (error) {
    logger.error?.('coverage.persist_failed', { requestId: record.id, message: error?.message || String(error) });
  }
}

/**
 * @param {import('express').Request} req
 * @param {any} config
 * @param {any} service
 */
function buildUpstreamHeaders(req, config, service) {
  /** @type {Record<string, string>} */
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || TRACKING_HEADERS.has(lower)) continue;
    if (config.proxy.stripRequestHeaders.includes(lower)) continue;
    if (value === undefined) continue;
    headers[lower] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  headers['content-type'] = 'application/json';
  headers.accept = 'application/json';
  Object.assign(headers, config.proxy.extraRequestHeaders || {}, service?.headers || {});
  return headers;
}

/**
 * @param {import('express').Request} req
 * @param {any} config
 * @param {string} serviceName
 */
function extractTracking(req, config, serviceName) {
  const header = (name) => decodeHeader(String(req.get(name) || '').trim());
  const query = (name) => decodeHeader(queryString(req.query?.[name]).trim());
  const testKey = header('x-test-id') || header('x-test-case') || query('test');
  const testName = header('x-test-name') || header('x-test-title') || testKey;
  return {
    run: {
      runId: header('x-run-id') || query('run'),
      branch: header('x-branch') || header('x-git-branch') || query('branch'),
      team: header('x-team') || query('team'),
      env: header('x-environment') || header('x-env') || query('env') || config.defaultEnv,
      build: header('x-build-id') || header('x-build-number') || query('build'),
      commit: header('x-commit') || query('commit'),
      service: serviceName,
      source: 'proxy',
    },
    test: { key: testKey, name: testName },
  };
}

/**
 * Заголовки HTTP допускают только latin1, поэтому кириллические названия
 * тестов/веток можно передавать в percent-encoding (encodeURIComponent).
 * @param {string} value
 */
function decodeHeader(value) {
  if (!value || !value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * @param {import('express').Request} req
 */
function extractPayload(req) {
  if (req.method === 'GET') {
    const query = queryString(req.query.query);
    let variables;
    const rawVariables = queryString(req.query.variables);
    if (rawVariables) {
      try {
        variables = JSON.parse(rawVariables);
      } catch {
        throw badRequest('Некорректный JSON в параметре variables');
      }
    }
    return { query, variables, operationName: queryString(req.query.operationName) || null };
  }

  const body = req.body;
  if (Array.isArray(body)) {
    throw badRequest('Batch-запросы (массив операций) не поддерживаются прокси');
  }
  if (typeof body === 'string') {
    return { query: body, variables: undefined, operationName: queryString(req.query.operationName) || null };
  }
  if (body && typeof body === 'object') {
    return {
      query: typeof body.query === 'string' ? body.query : '',
      variables: body.variables,
      operationName: body.operationName || queryString(req.query.operationName) || null,
    };
  }
  throw badRequest('Ожидается JSON-тело { query, variables, operationName } или Content-Type: application/graphql');
}
