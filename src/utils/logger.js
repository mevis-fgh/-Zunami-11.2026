/**
 * Минималистичный структурный логгер.
 * Пишет JSON-строки в stdout/stderr — удобно для Render, Docker и CI.
 */
const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 });

/**
 * @param {{ level?: string, bindings?: Record<string, unknown> }} [options]
 */
export function createLogger({ level = 'info', bindings = {} } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  const emit = (severity, msg, extra) => {
    if (LEVELS[severity] < threshold) return;
    const record = { time: new Date().toISOString(), level: severity, msg };
    Object.assign(record, bindings, extra || {});
    let line;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ time: record.time, level: severity, msg, extra: '[unserializable]' });
    }
    const stream = severity === 'error' || severity === 'warn' ? process.stderr : process.stdout;
    stream.write(`${line}\n`);
  };

  const logger = {
    level,
    child(extra = {}) {
      return createLogger({ level, bindings: { ...bindings, ...extra } });
    },
  };
  for (const severity of ['debug', 'info', 'warn', 'error']) {
    logger[severity] = (msg, extra) => emit(severity, msg, extra);
  }
  return logger;
}

export const silentLogger = createLogger({ level: 'silent' });
