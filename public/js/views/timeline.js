import { lineChart, timelinePoints } from '../charts.js';
import { sortedRuns } from '../store.js';
import { bar, esc, fmtDate, num, pageHead, pct, timeAgo } from '../ui.js';

export function renderTimeline({ href }) {
  const runs = sortedRuns();
  const ascending = [...runs].reverse();
  const points = timelinePoints(runs);
  const node = document.createElement('div');

  const rows = runs
    .map((run, index) => {
      const previous = runs[index + 1];
      const delta = previous ? Number((run.percent - previous.percent).toFixed(1)) : null;
      return `<tr class="clickable" data-run="${esc(run.runId)}">
        <td><div class="row-title">${esc(run.name || run.runId)}</div><div class="row-sub">${esc(run.branch || '—')} · ${esc(run.env || '—')}</div></td>
        <td class="muted nowrap">${fmtDate(run.startedAt)}</td>
        <td class="num">${num(run.requests)}</td>
        <td style="min-width:180px"><div class="bar-row">${bar(run.percent, { slim: true })}<span class="num">${pct(run.percent)}</span></div></td>
        <td class="num">${delta === null ? '—' : `<span class="${delta >= 0 ? 'green' : 'red'}">${delta >= 0 ? '+' : ''}${delta}</span>`}</td>
        <td class="num">${num(run.fieldsCovered)} / ${num(run.fieldsTotal)}</td>
      </tr>`;
    })
    .join('');

  node.innerHTML = `
    ${pageHead(
      'Динамика покрытия',
      'Прогресс по прогонам: процент покрытых полей и объём трафика. Хорошо видно, растёт ли покрытие от сборки к сборке.',
      `<a class="btn" href="${href('compare')}">Сравнить два прогона</a>`,
    )}

    <div class="card">
      <div class="card-head">
        <span class="card-title">Покрытие по прогонам</span>
        <span class="card-hint">${ascending.length} прогонов</span>
      </div>
      ${points.length > 1 ? lineChart(points, { height: 250 }) : '<div class="empty">Нужно хотя бы два прогона для графика.</div>'}
      <div class="timeline-legend">
        <span>— покрытие полей, %</span>
        <span>▮ количество запросов</span>
        <span>${ascending.length ? `${fmtDate(ascending[0].startedAt)} → ${fmtDate(ascending[ascending.length - 1].startedAt)}` : ''}</span>
      </div>
    </div>

    <div class="card mt-16">
      <div class="card-head"><span class="card-title">Прогоны</span><span class="card-hint">клик — фильтр по прогону</span></div>
      ${
        runs.length
          ? `<div class="table-wrap"><table class="table">
              <thead><tr><th>Прогон</th><th>Старт</th><th class="num">Запросов</th><th>Покрытие</th><th class="num">Δ</th><th class="num">Полей</th></tr></thead>
              <tbody>${rows}</tbody></table></div>`
          : '<div class="empty">Прогонов пока нет.</div>'
      }
    </div>`;

  node.querySelectorAll('tr[data-run]').forEach((row) => {
    row.addEventListener('click', () => {
      location.hash = href('overview', { run: row.dataset.run });
    });
  });

  return { node };
}
