import process from 'node:process';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { seedDemo } from './demo/seed.js';
import { buildSchemaGraph } from './schema/graph.js';
import { introspectEndpoint } from './schema/loader.js';
import { SchemaRegistry } from './schema/registry.js';
import { Repository } from './storage/repository.js';
import { createLogger } from './utils/logger.js';

/**
 * Точка входа. Запускается как обычный Node-процесс:
 *   npm start
 * Render задаёт PORT автоматически.
 */
async function main() {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });

  const repository = await new Repository({ config, logger }).init();
  await repository.prune();

  const registry = new SchemaRegistry({ repository, logger });
  const app = createApp({ config, repository, registry, logger });

  const server = app.listen(config.port, config.host, () => {
    logger.info('server.started', {
      url: `http://${config.host}:${config.port}`,
      nodeEnv: config.nodeEnv,
      dataDir: config.dataDir,
      services: Object.keys(config.services),
      auth: Boolean(config.proxy.apiKey || config.auth.adminToken),
    });
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  // Bootstrap выполняется после старта, чтобы healthcheck Render не ждал introspection.
  bootstrap({ config, repository, registry, logger }).catch((error) => {
    logger.error?.('bootstrap.failed', { message: error?.message || String(error) });
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('server.shutdown', { signal });
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    server.close(() => {
      clearTimeout(force);
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/**
 * Первичная инициализация: демо-данные или introspection активной схемы.
 */
async function bootstrap({ config, repository, registry, logger }) {
  if (config.demo.enabled) {
    const result = await seedDemo({ repository, logger });
    if (result.seeded) logger.info('bootstrap.demo', result);
  }

  if (repository.schemas.size > 0) return;
  if (!config.schema.autoIntrospect || !config.schema.introspectUrl) return;

  const endpoint = config.schema.introspectUrl;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const { schema, sdl } = await introspectEndpoint({
        endpoint,
        headers: config.schema.introspectHeaders,
        timeoutMs: config.proxy.timeoutMs,
      });
      const graph = buildSchemaGraph(schema);
      const snapshot = await repository.saveSchema({
        sdl,
        graph,
        source: 'introspection',
        endpoint,
        service: config.schema.introspectService,
        name: `auto · ${new URL(endpoint).hostname}`,
      });
      registry.invalidate(snapshot.id);
      logger.info('bootstrap.introspection_ok', { schemaId: snapshot.id, types: graph.stats.types, fields: graph.stats.fields });
      return;
    } catch (error) {
      logger.warn?.('bootstrap.introspection_failed', {
        attempt,
        endpoint,
        message: error?.message || String(error),
      });
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
    }
  }
}

main().catch((error) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});
