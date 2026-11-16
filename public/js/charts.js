import { esc, fmtDay, pct } from './ui.js';

let gradientSeq = 0;

/**
 * Линейный график покрытия по прогонам + столбики количества запросов.
 * @param {Array<{ label: string, percent: number, requests?: number, title?: string, runId?: string }>} points
 * @param {{ height?: number, showRequests?: boolean }} [options]
 */
export function lineChart(points, { height = 210, showRequests = true } = {}) {
  if (!points || points.length === 0) {
    return '<div class="empty">Нет данных для графика</div>';
  }

  const width = 720;
  const padLeft = 40;
  const padRight = 16;
  const padTop = 14;
  const padBottom = 34;
  const innerW = width - padLeft - padRight;
  const innerH = height - padTop - padBottom;
  const gradientId = `areaGradient${++gradientSeq}`;

  const maxRequests = Math.max(1, ...points.map((point) => Number(point.requests) || 0));
  const xAt = (index) =>
    padLeft + (points.length === 1 ? innerW / 2 : (index / (points.length - 1)) * innerW);
  const yAt = (value) => padTop + innerH - (Math.max(0, Math.min(100, Number(value) || 0)) / 100) * innerH;

  const linePath = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${xAt(index).toFixed(1)},${yAt(point.percent).toFixed(1)}`)
    .join(' ');
  const areaPath = `${linePath} L${xAt(points.length - 1).toFixed(1)},${padTop + innerH} L${xAt(0).toFixed(1)},${padTop + innerH} Z`;

  const grid = [0, 25, 50, 75, 100]
    .map((value) => {
      const y = yAt(value).toFixed(1);
      return `<line class="grid-line" x1="${padLeft}" y1="${y}" x2="${padLeft + innerW}" y2="${y}"/>
        <text x="${padLeft - 8}" y="${Number(y) + 3}" text-anchor="end">${value}%</text>`;
    })
    .join('');

  const bars = showRequests
    ? points
        .map((point, index) => {
          const barWidth = Math.max(3, (innerW / Math.max(points.length, 1)) * 0.34);
          const barHeight = ((Number(point.requests) || 0) / maxRequests) * innerH * 0.22;
          return `<rect class="bar-req" x="${(xAt(index) - barWidth / 2).toFixed(1)}" y="${(padTop + innerH - barHeight).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="2"><title>Запросов: ${Number(point.requests) || 0}</title></rect>`;
        })
        .join('')
    : '';

  const labelStep = Math.max(1, Math.ceil(points.length / 7));
  const labels = points
    .map((point, index) => {
      if (index % labelStep !== 0 && index !== points.length - 1) return '';
      return `<text x="${xAt(index).toFixed(1)}" y="${height - 10}" text-anchor="middle">${esc(point.label || '')}</text>`;
    })
    .join('');

  const dots = points
    .map((point, index) => {
      const title = point.title || `${point.label}: ${pct(point.percent)}`;
      return `<circle class="dot" cx="${xAt(index).toFixed(1)}" cy="${yAt(point.percent).toFixed(1)}" r="4">
        <title>${esc(title)}</title>
      </circle>`;
    })
    .join('');

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Динамика покрытия по прогонам">
    <defs>
      <linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#8b6dff" stop-opacity="0.34"/>
        <stop offset="100%" stop-color="#8b6dff" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${grid}
    ${bars}
    <path d="${areaPath}" fill="url(#${gradientId})"/>
    <path class="line" d="${linePath}"/>
    ${dots}
    ${labels}
  </svg>`;
}

/**
 * Мини-график для карточек (без осей).
 * @param {number[]} values
 */
export function sparkline(values = [], { width = 260, height = 54 } = {}) {
  if (values.length < 2) return '';
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const y = height - ((value - min) / span) * (height - 6) - 3;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <polyline points="${points.join(' ')}" fill="none" stroke="#8b6dff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

/**
 * Точки для графика из прогонов.
 * @param {any[]} runs
 */
export function timelinePoints(runs) {
  return [...(runs || [])]
    .filter((run) => run.startedAt)
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
    .map((run) => ({
      label: fmtDay(run.startedAt),
      percent: run.percent || 0,
      requests: run.requests || 0,
      runId: run.runId,
      title: `${run.name || run.runId} · ${run.branch || 'без ветки'} · ${pct(run.percent)}`,
    }));
}
