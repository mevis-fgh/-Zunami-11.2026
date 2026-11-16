import { api } from '../api.js';
import { sortedRuns } from '../store.js';
import { bar, esc, num, pageHead, pct } from '../ui.js';

export async function renderCompare({ params, href, go }) {
  const runs = sortedRuns();
  const node = document.createElement('div');

  if (runs.length < 2) {
    node.innerHTML = `
      ${pageHead('Сравнение прогонов', 'Нужно минимум два прогона, чтобы увидеть дельту покрытия.')}
      <div class="empty"><strong>Недостаточно данных</strong>Запустите тесты ещё раз — и сравнение появится автоматически.
        <div class="mt-16"><a class="btn" href="${href('runs')}">К прогонам</a></div></div>`;
    return { node };
  }

  const baseId = params.get('base') || runs[1].runId;
  const headId = params.get('head') || runs[0].runId;

  const options = (selected) =>
    runs
      .map(
        (run) =>
          `<option value="${esc(run.runId)}"${run.runId === selected ? ' selected' : ''}>${esc(run.name || run.runId)} · ${pct(run.percent)}</option>`,
      )
      .join('');

  node.innerHTML = `
    ${pageHead(
      'Сравнение прогонов',
      'Что покрылось, что потерялось и где ещё дыры. Удобно прикладывать к релизу.',
      `<a class="btn ghost" href="${href('timeline')}">Динамика</a>`,
    )}
    <div class="card">
      <div class="row wrap">
        <label class="filter"><span>Было</span><select class="field-input" id="cmp-base">${options(baseId)}</select></label>
        <span class="dim">→</span>
        <label class="filter"><span>Стало</span><select class="field-input" id="cmp-head">${options(headId)}</select></label>
        <div class="spacer grow"></div>
        <button class="btn primary" id="cmp-run">Сравнить</button>
      </div>
    </div>
    <div id="cmp-body" class="mt-16"><div class="card skeleton skeleton-block"></div></div>`;

  node.querySelector('#cmp-run')?.addEventListener('click', () => {
    const base = node.querySelector('#cmp-base').value;
    const head = node.querySelector('#cmp-head').value;
    go('compare', { base, head });
  });
  node.querySelector('#cmp-base')?.addEventListener('change', () => {
    go('compare', { base: node.querySelector('#cmp-base').value, head: node.querySelector('#cmp-head').value });
  });
  node.querySelector('#cmp-head')?.addEventListener('change', () => {
    go('compare', { base: node.querySelector('#cmp-base').value, head: node.querySelector('#cmp-head').value });
  });

  const body = node.querySelector('#cmp-body');
  if (baseId === headId) {
    body.innerHTML = `<div class="empty"><strong>Выбран один и тот же прогон</strong>Выберите разные прогоны, чтобы увидеть дельту.</div>`;
    return { node };
  }

  try {
    const data = await api(`/api/coverage/compare?base=${encodeURIComponent(baseId)}&head=${encodeURIComponent(headId)}`);
    body.innerHTML = renderResult(data);
  } catch (error) {
    body.innerHTML = `<div class="empty"><strong>Не удалось сравнить</strong>${esc(error.message)}</div>`;
  }
  return { node };
}

function renderResult(data) {
  const summary = data.summary;
  const positive = summary.deltaPercent >= 0;
  const list = (items, className, emptyText) =>
    items.length
      ? `<div class="chips">${items
          .slice(0, 120)
          .map((item) => `<span class="chip ${className}">${esc(item.key)}</span>`)
          .join('')}${items.length > 120 ? `<span class="chip">+${items.length - 120}</span>` : ''}</div>`
      : `<div class="muted small">${emptyText}</div>`;

  return `
    <div class="grid cols-4">
      <div class="card kpi"><div class="kpi-value">${pct(summary.basePercent)}</div><div class="kpi-label">было</div>
        <div class="mt-8">${bar(summary.basePercent)}</div></div>
      <div class="card kpi"><div class="kpi-value">${pct(summary.headPercent)}</div><div class="kpi-label">стало</div>
        <div class="mt-8">${bar(summary.headPercent)}</div></div>
      <div class="card kpi"><div class="kpi-value ${positive ? 'green' : 'red'}">${positive ? '+' : ''}${summary.deltaPercent}<small>п.п.</small></div>
        <div class="kpi-label">дельта покрытия</div>
        <div class="kpi-hint">${num(summary.headCovered - summary.baseCovered)} полей</div></div>
      <div class="card kpi"><div class="kpi-value">${num(summary.newlyCovered)}<small>+</small> / ${num(summary.regressed)}<small>−</small></div>
        <div class="kpi-label">новых / потерянных</div>
        <div class="kpi-hint">всего полей ${num(summary.fieldsTotal)}</div></div>    </div>

    <div class="grid cols-3 mt-16">
      <div class="card">
        <div class="card-head"><span class="card-title green">Новые поля</span><span class="card-hint">${data.newlyCovered.length}</span></div>
        ${list(data.newlyCovered, 'covered', 'Ничего нового не покрыто.')}
      </div>
      <div class="card">
        <div class="card-head"><span class="card-title red">Потерянные поля</span><span class="card-hint">${data.regressed.length}</span></div>
        ${list(data.regressed, 'uncovered', 'Регрессий нет.')}
      </div>
      <div class="card">
        <div class="card-head"><span class="card-title">Всё ещё не покрыто</span><span class="card-hint">${data.stillUncovered.length}</span></div>
        ${list(data.stillUncovered, '', 'Все поля покрыты.')}
      </div>
    </div>

    <div class="card mt-16">
      <div class="card-head"><span class="card-title">Изменение интенсивности</span><span class="card-hint">топ по модулю дельты</span></div>
      ${
        data.changed.length
          ? `<div class="table-wrap"><table class="table"><thead><tr><th>Поле</th><th class="num">Было</th><th class="num">Стало</th><th class="num">Δ</th></tr></thead><tbody>
              ${data.changed
                .slice(0, 40)
                .map(
                  (item) => `<tr><td class="mono">${esc(item.key)}</td><td class="num">${num(item.hitsBefore)}</td>
                    <td class="num">${num(item.hitsAfter)}</td>
                    <td class="num ${item.delta >= 0 ? 'green' : 'red'}">${item.delta >= 0 ? '+' : ''}${num(item.delta)}</td></tr>`,
                )
                .join('')}
            </tbody></table></div>`
          : '<div class="muted small">Частота обращений не изменилась.</div>'
      }
    </div>`;
}
