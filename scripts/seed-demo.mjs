#!/usr/bin/env node
/**
 * Наполняет хранилище демо-данными (схема + 4 прогона).
 * Использование:
 *   npm run seed            — в DATA_DIR (по умолчанию ./data)
 *   DEMO_MODE=true npm start — сидер сработает автоматически на пустом хранилище
 */
import { loadConfig } from '../src/config.js';
import { seedDemo } from '../src/demo/seed.js';
import { Repository } from '../src/storage/repository.js';
import { createLogger } from '../src/utils/logger.js';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel });
const repository = await new Repository({ config, logger }).init();
const result = await seedDemo({ repository, logger });

if (!result.seeded) {
  logger.warn('seed.skipped', { reason: result.reason, dataDir: config.dataDir });
  process.exit(0);
}
logger.info('seed.done', { ...result, dataDir: config.dataDir });
