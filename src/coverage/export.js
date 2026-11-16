import { toCsv } from '../utils/text.js';

/**
 * CSV-экспорт покрытия полей.
 * @param {any} view
 */
export function fieldsCsv(view) {
  const rows = (view.fields || []).map((field) => [
    field.key.split('.')[0],
    field.name,
    field.type,
    field.status,
    field.hits,
    field.testCount,
    field.argsCovered,
    field.argsTotal,
    field.depth || 0,
    field.lastSeen || '',
    field.deprecated ? 'yes' : 'no',
  ]);
  return toCsv(
    ['Type', 'Field', 'ReturnType', 'Status', 'Hits', 'Tests', 'ArgsCovered', 'ArgsTotal', 'Depth', 'LastSeen', 'Deprecated'],
    rows,
  );
}

/**
 * CSV-экспорт типов.
 * @param {any} view
 */
export function typesCsv(view) {
  const rows = (view.types || []).map((type) => [
    type.name,
    type.kind,
    type.status,
    type.fieldsCovered,
    type.fieldsCount,
    type.percent,
    type.hits,
    type.testCount,
    type.isRoot ? 'root' : '',
  ]);
  return toCsv(['Type', 'Kind', 'Status', 'FieldsCovered', 'FieldsTotal', 'Percent', 'Hits', 'Tests', 'Root'], rows);
}

/**
 * CSV-экспорт операций.
 * @param {any} view
 */
export function operationsCsv(view) {
  const rows = (view.operations || []).map((operation) => [
    operation.type,
    operation.name || '',
    operation.key,
    operation.count,
    operation.maxDepth,
    operation.lastSeen || '',
  ]);
  return toCsv(['OperationType', 'Name', 'Key', 'Count', 'MaxDepth', 'LastSeen'], rows);
}

/**
 * CSV-экспорт «дыр» покрытия.
 * @param {any} view
 */
export function gapsCsv(view) {
  return toCsv(
    ['Type', 'Field', 'ReturnType', 'Deprecated'],
    (view.uncovered || []).map((gap) => [gap.type, gap.name, gap.typeRef, gap.deprecated ? 'yes' : 'no']),
  );
}

/**
 * Небольшой SVG-бейдж для CI (README / MR).
 * @param {{ label?: string, percent: number, color?: string }} options
 */
export function coverageBadgeSvg({ label = 'coverage', percent = 0, color }) {
  const value = `${Math.round(percent)}%`;
  const fill = color || (percent >= 80 ? '#22c55e' : percent >= 50 ? '#f59e0b' : '#ef4444');
  const labelWidth = 8 + label.length * 6.8;
  const valueWidth = 14 + value.length * 7.2;
  const total = Math.round(labelWidth + valueWidth);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${label}: ${value}">
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <rect width="${total}" height="20" rx="3" fill="#111827"/>
  <rect width="${Math.round(labelWidth)}" height="20" rx="3" fill="#374151"/>
  <rect x="${Math.round(labelWidth)}" width="${Math.round(valueWidth)}" height="20" rx="3" fill="${fill}"/>
  <rect width="${total}" height="20" rx="3" fill="url(#s)"/>
  <g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">
    <text x="${Math.round(labelWidth / 2)}" y="14">${label}</text>
    <text x="${Math.round(labelWidth + valueWidth / 2)}" y="14">${value}</text>
  </g>
</svg>`;
}
