import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApiRouter } from './api/routes.js';
import { createProxyRouter } from './proxy/proxy-router.js';
import { errorPayload } from './utils/errors.js';
import { nowIso } from './utils/id.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(HERE, '..', 'public');

const CORS_HEADERS = [
  'content-type',
  'authorization',
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
  'x-admin-token',
  'x-request-id',
].join(', ');

const CORS_EXPOSE = [
  'x-coverage-proxy-request-id',
  'x-coverage-proxy-run-id',
  'x-coverage-proxy-service',
  'x-coverage-proxy-fields',
  'x-coverage-proxy-valid',
  'x-request-id',
].join(', ');

/**
 * Собирает Express-приложение: прокси + REST API + SPA.
 *
 * @param {{ config: any, repository: any, registry: any, logger: any }} deps
 */
export function createApp({ config, repository, registry, logger }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.set('etag', false);

  app.use(corsMiddleware(config));

  app.use((req, res, next) => {
    const requestId = req.get('x-request-id') || `srv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    res.setHeader('x-request-id', requestId);
    req.requestId = requestId;
    next();
  });

  app.get('/healthz', (req, res) => {
    const active = repository.getActiveSchema();
    res.json({
      status: 'ok',
      version: config.version,
      uptimeSeconds: Math.round(process.uptime()),
      now: nowIso(),
      storage: { dataDir: config.dataDir, writable: true },
      schema: active
        ? { id: active.id, name: active.name, service: active.service, types: active.stats?.types || 0, fields: active.stats?.fields || 0 }
        : null,
      counts: { schemas: repository.schemas.size, runs: repository.runs.size },
    });
  });

  app.use(
    express.json({
      limit: config.proxy.maxBodyBytes,
      type: ['application/json', 'application/*+json'],
    }),
  );
  app.use(
    express.text({
      limit: config.proxy.maxBodyBytes,
      type: ['application/graphql', 'text/plain'],
    }),
  );

  app.use(createProxyRouter({ config, repository, registry, logger }));
  app.use('/api', createApiRouter({ config, repository, registry, logger }));

  app.use('/api', (req, res) => {
    res.status(404).json({ error: { message: `Неизвестный эндпоинт ${req.method} ${req.originalUrl}`, code: 'NOT_FOUND' } });
  });

  app.use(
    express.static(PUBLIC_DIR, {
      maxAge: config.isProduction ? '1h' : 0,
      extensions: ['html'],
      index: 'index.html',
    }),
  );

  app.get(/^(?!\/api\/|\/proxy|\/graphql|\/healthz).*/, (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    let normalized = error;
    if (error?.type === 'entity.parse.failed') {
      normalized = Object.assign(new Error('Некорректный JSON в теле запроса'), { status: 400, code: 'INVALID_JSON' });
    } else if (error?.type === 'entity.too.large') {
      normalized = Object.assign(new Error('Тело запроса слишком большое'), { status: 413, code: 'PAYLOAD_TOO_LARGE' });
    }
    const status = Number(normalized?.status) || 500;
    if (status >= 500) {
      logger.error?.('request.failed', {
        method: req.method,
        url: req.originalUrl,
        message: normalized?.message || String(normalized),
        stack: normalized?.stack?.split('\n').slice(0, 5).join(' | '),
      });
    }
    const payload = errorPayload(normalized);
    if (normalized?.type === 'entity.parse.failed') payload.error.code = 'INVALID_JSON';
    if (normalized?.type === 'entity.too.large') payload.error.code = 'PAYLOAD_TOO_LARGE';
    res.status(status).json(payload);
  });

  return app;
}

/** @param {any} config */
function corsMiddleware(config) {
  const origin = config.cors.origin || '*';
  return (req, res, next) => {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', CORS_HEADERS);
    res.setHeader('access-control-expose-headers', CORS_EXPOSE);
    res.setHeader('access-control-max-age', '600');
    if (origin !== '*') res.setHeader('vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}
