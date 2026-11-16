import { createHash, randomBytes } from 'node:crypto';

/**
 * Короткий уникальный идентификатор с префиксом.
 * @param {string} [prefix]
 */
export function newId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(5).toString('hex')}`;
}

/**
 * Детерминированный короткий хеш строки (для id снапшотов схемы).
 * @param {string} value
 * @param {number} [length]
 */
export function shortHash(value, length = 12) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, length);
}

export function nowIso() {
  return new Date().toISOString();
}

/** Разрешённые символы идентификатора прогона/схемы (защита от path traversal). */
export const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

/** @param {unknown} value */
export function isSafeId(value) {
  return typeof value === 'string' && SAFE_ID_RE.test(value);
}

/**
 * Приводит произвольную строку к безопасному slug-идентификатору.
 * @param {unknown} value
 * @param {number} [maxLength]
 */
export function slugify(value, maxLength = 60) {
  return String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLength);
}
