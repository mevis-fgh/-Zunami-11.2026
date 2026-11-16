import path from 'node:path';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

/** @param {unknown} value @param {boolean} [fallback] */
const toBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return TRUE_VALUES.has(String(value).trim().toLowerCase());
};

/** @param {unknown} value @param {number} fallback */
const toInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** @param {unknown} value */
const toList = (value) =>
  String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

/** @param {unknown} value @param {unknown} fallback */
const toJson = (value, fallback) => {
  if (!value) return fallback;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
};

/**
 * @typedef {Object} ServiceTarget
 * @property {string} url
 * @property {Record<string, string>} [headers]
 * @property {string} [schemaUrl]
 */

/**
 * @typedef {ReturnType<typeof loadConfig>} Config
 */

/**
 * Собирает конфигурацию из переменных окружения.
 * Все значения имеют безопасные дефолты, чтобы сервис стартовал «из коробки».
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';
  const dataDir = path.resolve(env.DATA_DIR || path.join(process.cwd(), 'data'));

  /** @type {Record<string, ServiceTarget>} */
  const services = { ...toJson(env.SERVICES_JSON, {}) };
  if (env.TARGET_GRAPHQL_URL) {
    services.default = { ...(services.default || {}), url: env.TARGET_GRAPHQL_URL };
  }
  if (!services.default) services.default = { url: '' };

  const proxyApiKey = env.PROXY_API_KEY || '';

  return {
    version: '1.0.0',
    nodeEnv,
    isProduction,
    host: env.HOST || '0.0.0.0',
    port: toInt(env.PORT, 3000),
    publicBaseUrl: env.PUBLIC_BASE_URL || '',
    dataDir,
    logLevel: env.LOG_LEVEL || 'info',
    defaultEnv: env.DEFAULT_ENV || (isProduction ? 'production' : 'local'),

    services,

    proxy: {
      apiKey: proxyApiKey,
      allowTargetOverride: toBool(env.ALLOW_TARGET_OVERRIDE, false),
      /** @type {string[]} */
      allowedTargetHosts: toList(env.ALLOWED_TARGET_HOSTS),
      allowPrivateTargets: toBool(env.ALLOW_PRIVATE_TARGETS, !isProduction),
      timeoutMs: toInt(env.UPSTREAM_TIMEOUT_MS, 20000),
      maxBodyBytes: toInt(env.MAX_BODY_MB, 8) * 1024 * 1024,
      maxResponseBytes: toInt(env.MAX_RESPONSE_MB, 16) * 1024 * 1024,
      maxQueryChars: toInt(env.MAX_QUERY_CHARS, 200000),
      strictValidation: toBool(env.PROXY_STRICT_VALIDATION, false),
      /** @type {string[]} */
      stripRequestHeaders: toList(env.PROXY_STRIP_HEADERS),
      /** @type {Record<string, string>} */
      extraRequestHeaders: toJson(env.PROXY_EXTRA_HEADERS, {}),
      /** @type {Record<string, string>} */
      extraResponseHeaders: toJson(env.PROXY_EXTRA_RESPONSE_HEADERS, {}),
    },

    auth: {
      adminToken: env.ADMIN_TOKEN || '',
    },

    schema: {
      autoIntrospect: toBool(env.AUTO_INTROSPECT, true),
      introspectService: env.SCHEMA_SERVICE || 'default',
      introspectUrl: env.SCHEMA_INTROSPECT_URL || env.TARGET_GRAPHQL_URL || '',
      /** @type {Record<string, string>} */
      introspectHeaders: toJson(env.SCHEMA_INTROSPECT_HEADERS, {}),
    },

    storage: {
      retentionDays: toInt(env.RETENTION_DAYS, 30),
      executionLookbackDays: toInt(env.EXECUTION_LOOKBACK_DAYS, 14),
      maxRunsInMerge: toInt(env.MAX_RUNS_IN_MERGE, 200),
    },

    /** Режим склейки авто-прогонов, если тесты не передают x-run-id: daily | session | off */
    autoRunMode: (env.AUTO_RUN_MODE || 'daily').toLowerCase(),

    demo: {
      enabled: toBool(env.DEMO_MODE, false),
    },

    cors: {
      origin: env.CORS_ORIGIN || '*',
    },
  };
}

/**
 * Безопасное представление конфигурации для UI (без секретов).
 * @param {Config} config
 */
export function publicConfig(config) {
  return {
    version: config.version,
    nodeEnv: config.nodeEnv,
    defaultEnv: config.defaultEnv,
    autoRunMode: config.autoRunMode,
    demo: config.demo.enabled,
    proxy: {
      authRequired: Boolean(config.proxy.apiKey),
      allowTargetOverride: config.proxy.allowTargetOverride,
      strictValidation: config.proxy.strictValidation,
      timeoutMs: config.proxy.timeoutMs,
    },
    services: Object.fromEntries(
      Object.entries(config.services).map(([name, service]) => [
        name,
        { configured: Boolean(service?.url), url: service?.url ? maskUrl(service.url) : '' },
      ]),
    ),
    schema: {
      autoIntrospect: config.schema.autoIntrospect,
      introspectUrl: config.schema.introspectUrl ? maskUrl(config.schema.introspectUrl) : '',
    },
  };
}

/** Скрывает токены/креды в URL. @param {string} raw */
export function maskUrl(raw) {
  try {
    const url = new URL(raw);
    for (const key of ['token', 'access_token', 'api_key', 'key', 'secret']) {
      if (url.searchParams.has(key)) url.searchParams.set(key, '***');
    }
    if (url.username) url.username = '***';
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return raw;
  }
}
