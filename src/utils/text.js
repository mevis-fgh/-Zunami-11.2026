/**
 * Работа с текстом и JSON без внешних зависимостей.
 */

/** @param {unknown} value @param {number} max */
export function truncate(value, max) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[truncated ${text.length - max} chars]`;
}

/** @param {string} text @param {number} [max] */
export function truncateText(text, max = 4000) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n/* … обрезано ${text.length - max} символов */`;
}

/** @param {unknown} value */
export function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!['{', '[', '"'].includes(trimmed[0]) && trimmed !== 'null' && !/^-?\d/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/** @param {unknown} value @param {number} [depth] */
export function sanitizeValue(value, depth = 0) {
  if (depth > 6) return '[deep]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncateText(value, 2000);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (key.length > 120) continue;
      out[key] = sanitizeValue(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** Экранирование значения для CSV (Excel-совместимо, разделитель `;`). */
export function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

/** @param {string[]} headers @param {Array<Array<unknown>>} rows */
export function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(';')];
  for (const row of rows) lines.push(row.map(csvCell).join(';'));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** @param {number} value */
export function round1(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : 0;
}

/**
 * Безопасно приводит query-параметр к строке.
 * @param {unknown} value
 */
export function queryString(value) {
  if (Array.isArray(value)) return String(value[0] ?? '');
  return value === undefined || value === null ? '' : String(value);
}

/**
 * Приводит список значений из query (`a=1&a=2` или `a=1,2`) к массиву.
 * @param {unknown} value
 */
export function queryList(value) {
  if (Array.isArray(value)) return value.flatMap((item) => String(item).split(',')).map((s) => s.trim()).filter(Boolean);
  if (value === undefined || value === null || value === '') return [];
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}
