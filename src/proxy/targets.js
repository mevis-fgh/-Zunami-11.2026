import { badRequest, forbidden } from '../utils/errors.js';
import { normalizeHttpUrl } from '../schema/loader.js';

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^0\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];
const PRIVATE_HOSTS = new Set(['localhost', 'metadata.google.internal', '[::1]', '::1', '0.0.0.0']);
const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

/** @param {string} hostname */
export function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (PRIVATE_HOSTS.has(host)) return true;
  if (PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (PRIVATE_V4.some((pattern) => pattern.test(host))) return true;
  // IPv6 link-local / unique local
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
  return false;
}

/**
 * Проверяет, что хост входит в allowlist (поддерживает `*.example.com`).
 * @param {string} hostname
 * @param {string[]} allowlist
 */
export function hostAllowed(hostname, allowlist) {
  if (!allowlist || allowlist.length === 0) return true;
  const host = String(hostname || '').toLowerCase();
  return allowlist.some((entry) => {
    const rule = String(entry).toLowerCase().trim();
    if (!rule) return false;
    if (rule.startsWith('*.')) return host === rule.slice(2) || host.endsWith(rule.slice(1));
    return host === rule;
  });
}

/**
 * Валидирует целевой URL с учётом SSRF-защиты.
 * @param {string} rawUrl
 * @param {any} config
 */
export function assertTargetUrl(rawUrl, config) {
  const normalized = normalizeHttpUrl(rawUrl);
  const url = new URL(normalized);
  if (!hostAllowed(url.hostname, config.proxy.allowedTargetHosts)) {
    throw forbidden(`Хост ${url.hostname} не входит в ALLOWED_TARGET_HOSTS`);
  }
  if (!config.proxy.allowPrivateTargets && isPrivateHost(url.hostname)) {
    throw forbidden('Запросы к приватным/локальным адресам запрещены (ALLOW_PRIVATE_TARGETS=false)');
  }
  return normalized;
}

/**
 * Определяет, куда проксировать запрос.
 * Порядок: явный override (если разрешён) → именованный сервис → default.
 *
 * @param {any} config
 * @param {import('express').Request} req
 */
export function resolveTarget(config, req) {
  const override = String(req.get('x-target-url') || req.query.target || '').trim();
  const serviceName = String(req.get('x-service') || req.query.service || 'default').trim() || 'default';

  if (override) {
    if (!config.proxy.allowTargetOverride) {
      throw forbidden('Override целевого URL отключён (ALLOW_TARGET_OVERRIDE=false)');
    }
    if (serviceName !== 'default' && !config.services[serviceName]) {
      throw badRequest(`Неизвестный сервис "${serviceName}"`);
    }
    return {
      url: assertTargetUrl(override, config),
      serviceName,
      service: config.services[serviceName] || {},
      overridden: true,
    };
  }

  const service = config.services[serviceName];
  if (!service || !service.url) {
    throw badRequest(
      service
        ? `Для сервиса "${serviceName}" не задан URL (TARGET_GRAPHQL_URL / SERVICES_JSON)`
        : `Неизвестный сервис "${serviceName}". Доступны: ${Object.keys(config.services).join(', ')}`,
    );
  }
  return {
    url: assertTargetUrl(service.url, config),
    serviceName,
    service,
    overridden: false,
  };
}
