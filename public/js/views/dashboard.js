import { lineChart, timelinePoints } from '../charts.js';
import { sortedRuns, state, summary, uncoveredByType } from '../store.js';
import { bar, esc, fmtDate, num, pageHead, pct, ring, timeAgo } from '../ui.js';

export function renderDashboard({ href }) {
  const current = summary();
  const runs = sortedRuns();
  const coverage = state.coverage;
  const topFields = coverage?.topFields || [];
  const gaps = uncoveredByType();
  const activeRun = state.filters.run ? runs.find((run) => run.runId === state.filters.run) : null;

  const previousRun = activeRun ? runs[runs.indexOf(activeRun) + 1] : runs[1];
  const delta = previousRun && activeRun ? Number((activeRun.percent - previousRun.percent).toFixed(1)) : null;
  const latest = runs[0];
  const maxHits = Math.max(1, ...topFields.map((field) => field.hits));

  const node = document.createElement('div');
  node.innerHTML = `
    ${pageHead(
      'Обзор покрытия',
      `Срез: ${esc(scopeText())} · обновлено ${timeAgo(new Date(state.lastLoadedAt).toISOString())}`,
      `<a class="btn" href="${href('graph')}">Открыть граф</a>
       <a class="btn" href="${href('fields', { status: 'uncovered' })}">Найти непокрытое</a>`,
    )}

    <div class="grid dashboard">
      <div class="stack">
        <div class="card">
          <div class="ring-wrap">
            ${ring(current.fieldsPercent)}
            <div class="stack grow" style="gap:16px">
              <div>
                <div class="kpi-label">Покрытие схемы (поля)</div>
                <div class="kpi-value">${num(current.fieldsCovered)}<small>из ${num(current.fieldsTotal)}</small></div>
                <div class="kpi-hint">
                  ${
                    delta !== null
                      ? `<span class="${delta >= 0 ? 'green' : 'red'}">${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta)} п.п.</span> к предыдущему прогону`
                      : latest
                        ? `последний прогон: ${esc(latest.name || latest.runId)}`
                        : 'прогонов пока нет'
                  }
                </div>
              </div>
              <div class="kpi-row two">
                <div class="kpi"><div class="kpi-value">${pct(current.typesPercent)}</div><div class="kpi-label">типы затронуты</div><div class="kpi-hint">${num(current.typesCovered)} / ${num(current.typesTotal)}</div></div>
                <div class="kpi"><div class="kpi-value">${pct(current.argsPercent)}</div><div class="kpi-label">аргументы</div><div class="kpi-hint">${num(current.argsCovered)} / ${num(current.argsTotal)}</div></div>
                <div class="kpi"><div class="kpi-value">${num(current.requests)}</div><div class="kpi-label">запросов</div><div class="kpi-hint">глубина ≤ ${num(current.maxDepth)}</div></div>
                <div class="kpi"><div class="kpi-value">${num(current.tests)}</div><div class="kpi-label">тестов</div><div class="kpi-hint">${num(current.runs)} прогонов</div></div>
              </div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <span class="card-title">Самые используемые поля</span>
            <a class="card-hint" href="${href('fields')}">все поля →</a>
          </div>
          ${
            topFields.length
              ? `<div class="list">${topFields
                  .slice(0, 8)
                  .map(
                    (field) => `<a class="list-row" href="${href('type', { name: field.type })}">
                      <div class="grow">
                        <div class="title mono">${esc(field.key)}</div>
                        <div class="sub">${num(field.tests)} тестов</div>
                      </div>
                      <div class="bar-row" style="width:200px">
                        <div class="bar"><span style="width:${Math.max(3, (field.hits / maxHits) * 100)}%"></span></div>
                        <div class="num">${num(field.hits)}</div>
                      </div>
                    </a>`,
                  )
                  .join('')}</div>`
              : '<div class="muted">Пока нет запросов.</div>'
          }
        </div>

        <div class="card">
          <div class="card-head">
            <span class="card-title">Где дыры</span>
            <a class="card-hint" href="${href('fields', { status: 'uncovered' })}">список непокрытых →</a>
          </div>
          ${
            gaps.length
              ? `<div class="stack">${gaps
                  .slice(0, 6)
                  .map(
                    (group) => `<div>
                      <div class="row" style="justify-content:space-between">
                        <a class="mono" href="${href('type', { name: group.typeName })}">${esc(group.typeName)}</a>
                        <span class="dim small">${group.fields.length} непокрытых</span>
                      </div>
                      <div class="chips mt-8">${group.fields
                        .slice(0, 6)
                        .map((field) => `<span class="chip uncovered">${esc(field.name)}</span>`)
                        .join('')}${group.fields.length > 6 ? `<span class="chip">+${group.fields.length - 6}</span>` : ''}</div>
                    </div>`,
                  )
                  .join('')}</div>`
              : '<div class="muted">Все поля покрыты. Отличная работа.</div>'
          }
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head"><span class="card-title">Два разреза</span></div>
          <div class="stack">
            <div>
              <div class="row" style="justify-content:space-between"><span>Schema coverage</span><strong>${pct(current.fieldsPercent)}</strong></div>
              ${bar(current.fieldsPercent)}
              <div class="kpi-hint">Поля, которые хотя бы раз запрашивались (любой трафик).</div>
            </div>
            <div>
              <div class="row" style="justify-content:space-between"><span>Test coverage</span><strong>${pct(current.testCoverage.percent)}</strong></div>
              ${bar(current.testCoverage.percent)}
              <div class="kpi-hint">Поля, до которых дошли именованные тест-кейсы (${num(current.testCoverage.tests)} шт.).</div>
            </div>
            <div class="row" style="justify-content:space-between">
              <span class="muted small">Непокрытых полей</span><strong class="red">${num(current.uncoveredFields)}</strong>
            </div>
            <div class="row" style="justify-content:space-between">
              <span class="muted small">Ошибок upstream</span><strong>${num(current.errors)}</strong>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <span class="card-title">Последние прогоны</span>
            <a class="card-hint" href="${href('runs')}">все →</a>
          </div>
          ${
            runs.length
              ? `<div class="list">${runs
                  .slice(0, 5)
                  .map(
                    (run) => `<a class="list-row" href="${href('overview', { run: run.runId })}">
                      <div class="grow">
                        <div class="title">${esc(run.name || run.runId)}</div>
                        <div class="sub">${esc(run.branch || '—')} · ${esc(run.env || '—')} · ${timeAgo(run.startedAt)}</div>
                      </div>
                      <div class="bar-row" style="width:140px">
                        ${bar(run.percent, { slim: true })}
                        <div class="num">${pct(run.percent)}</div>
                      </div>
                    </a>`,
                  )
                  .join('')}</div>`
              : '<div class="muted">Прогонов пока нет — отправьте первый запрос через прокси.</div>'
          }
        </div>

        <div class="card">
          <div class="card-head">
            <span class="card-title">Динамика</span>
            <a class="card-hint" href="${href('timeline')}">подробнее →</a>
          </div>
          ${runs.length > 1 ? lineChart(timelinePoints(runs.slice(0, 8)), { height: 190 }) : '<div class="muted">Появится после второго прогона.</div>'}
        </div>

        <div class="card">
          <div class="card-head"><span class="card-title">Операции</span></div>
          ${
            (coverage?.operations || []).length
              ? `<div class="chips">${coverage.operations
                  .slice(0, 10)
                  .map((operation) => `<span class="chip covered">${esc(operation.key)} <span class="dim">×${num(operation.count)}</span></span>`)
                  .join('')}</div>`
              : '<div class="muted">Пока нет операций.</div>'
          }
        </div>
      </div>
    </div>

    <div class="card mt-16">
      <div class="card-head"><span class="card-title">Активные тесты</span><a class="card-hint" href="${href('requests')}">журнал запросов →</a></div>
      ${
        (coverage?.tests || []).length
          ? `<div class="table-wrap"><table class="table"><thead><tr><th>Тест</th><th>Запросов</th><th>Полей</th><th>Первый запуск</th><th>Последний</th></tr></thead><tbody>
              ${coverage.tests
                .slice(0, 12)
                .map(
                  (test) => `<tr>
                    <td class="mono">${esc(test.name || test.key)}</td>
                    <td class="num">${num(test.requests)}</td>
                    <td class="num">${num(test.fieldsCovered)}</td>
                    <td class="muted nowrap">${fmtDate(test.firstSeen)}</td>
                    <td class="muted nowrap">${timeAgo(test.lastSeen)}</td>
                  </tr>`,
                )
                .join('')}
            </tbody></table></div>`
          : '<div class="muted">Тест-кейсы появятся, когда запросы придут с заголовком <span class="mono">x-test-id</span> или <span class="mono">x-test-name</span>.</div>'
      }
    </div>`;

  return { node };
}

function scopeText() {
  const filters = state.filters || {};
  if (filters.run) return `прогон ${filters.run}`;
  const parts = [];
  if (filters.branch) parts.push(`ветка ${filters.branch}`);
  if (filters.team) parts.push(`команда ${filters.team}`);
  if (filters.env) parts.push(`окружение ${filters.env}`);
  if (parts.length) return parts.join(' · ');
  return `все прогоны (${state.runTotal || 0})`;
}
