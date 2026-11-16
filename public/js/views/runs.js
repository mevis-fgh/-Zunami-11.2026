import { post } from '../api.js';
import { state, sortedRuns } from '../store.js';
import { bar, esc, num, openModal, pageHead, pct, statusBadge, timeAgo, toast } from '../ui.js';

export function renderRuns({ href }) {
  const runs = sortedRuns();
  const node = document.createElement('div');
  const facets = state.facets || {};

  const rows = runs
    .map((run, index) => {
      const previous = runs[index + 1];
      const compareHref = previous ? href('compare', { base: previous.runId, head: run.runId }) : '';
      return `<tr>
        <td>
          <div class="row-title">${esc(run.name || run.runId)}</div>
          <div class="row-sub mono">${esc(run.runId)}</div>
        </td>
        <td>
          <div>${esc(run.branch || '—')}</div>
          <div class="row-sub">${esc(run.team || '—')} · ${esc(run.env || '—')}</div>
        </td>
        <td class="mono dim">${esc(run.build || '—')}</td>
        <td class="num">${num(run.requests)}</td>
        <td style="min-width:170px"><div class="bar-row">${bar(run.percent, { slim: true })}<span class="num">${pct(run.percent)}</span></div></td>
        <td>${statusBadge(run.status, run.status === 'finished' ? 'завершён' : run.status === 'running' ? 'идёт' : run.status)}</td>
        <td class="muted nowrap" title="${esc(run.startedAt)}">${timeAgo(run.startedAt)}</td>
        <td class="tight nowrap">
          <a class="btn small ghost" href="${href('overview', { run: run.runId })}">Обзор</a>
          <a class="btn small ghost" href="${href('requests', { run: run.runId })}">Запросы</a>
          ${compareHref ? `<a class="btn small ghost" href="${compareHref}">Δ</a>` : ''}
        </td>
      </tr>`;
    })
    .join('');

  node.innerHTML = `
    ${pageHead(
      'Прогоны',
      `История запусков: ${num(state.runTotal || runs.length)} записей. Фильтры сверху применяются к покрытию и списку.`,
      `<button class="btn primary" id="btn-new-run">Новый прогон</button>
       <a class="btn ghost" href="/api/runs?limit=200" target="_blank" rel="noreferrer">JSON</a>`,
    )}

    <div class="row wrap" style="margin-bottom:14px">
      ${facets.branches?.length ? `<span class="muted small">Ветки:</span>${facets.branches
        .map((branch) => `<a class="chip" href="${href('runs', { branch })}">${esc(branch)}</a>`)
        .join('')}` : ''}
      ${facets.envs?.length ? `<span class="muted small" style="margin-left:8px">Окружения:</span>${facets.envs
        .map((env) => `<a class="chip" href="${href('runs', { env })}">${esc(env)}</a>`)
        .join('')}` : ''}
      <label class="filter" style="margin-left:auto"><span>С</span>
        <input type="date" class="field-input" id="runs-from" value="${esc((state.filters.from || '').slice(0, 10))}" />
      </label>
      <label class="filter"><span>По</span>
        <input type="date" class="field-input" id="runs-to" value="${esc((state.filters.to || '').slice(0, 10))}" />
      </label>
    </div>

    ${
      runs.length
        ? `<div class="table-wrap"><table class="table">
            <thead><tr><th>Прогон</th><th>Ветка / команда</th><th>Build</th><th class="num">Запросов</th><th>Покрытие</th><th>Статус</th><th>Старт</th><th></th></tr></thead>
            <tbody>${rows}</tbody></table></div>`
        : `<div class="empty"><strong>Прогонов нет</strong>Запустите тесты через <span class="mono">/proxy</span> или создайте прогон вручную.
            <div class="mt-16"><button class="btn" id="btn-new-run-empty">Создать прогон</button></div></div>`
    }`;

  const openCreate = () => {
    const modal = openModal({
      title: 'Новый прогон',
      subtitle: 'Ручная регистрация прогона — запросы можно дослать через /proxy или /api/ingest',
      width: 560,
      body: `<div class="form-grid">
          <div class="form-row"><label>Run ID</label><input class="input mono" id="nr-id" placeholder="ci-1042" /></div>
          <div class="form-row"><label>Название</label><input class="input" id="nr-name" placeholder="CI #1042 · регресс" /></div>
          <div class="form-row"><label>Ветка</label><input class="input" id="nr-branch" placeholder="main" /></div>
          <div class="form-row"><label>Команда</label><input class="input" id="nr-team" placeholder="qa" /></div>
          <div class="form-row"><label>Окружение</label><input class="input" id="nr-env" placeholder="staging" /></div>
          <div class="form-row"><label>Build</label><input class="input" id="nr-build" placeholder="1042" /></div>
        </div>
        <div class="form-error" id="nr-error"></div>`,
      footer: '<button class="btn ghost" data-close>Отмена</button><button class="btn primary" id="nr-create">Создать</button>',
    });

    modal.element.querySelector('#nr-create')?.addEventListener('click', async () => {
      const errorNode = modal.element.querySelector('#nr-error');
      const payload = {
        runId: modal.element.querySelector('#nr-id').value.trim(),
        name: modal.element.querySelector('#nr-name').value.trim(),
        branch: modal.element.querySelector('#nr-branch').value.trim(),
        team: modal.element.querySelector('#nr-team').value.trim(),
        env: modal.element.querySelector('#nr-env').value.trim(),
        build: modal.element.querySelector('#nr-build').value.trim(),
      };
      try {
        await post('/api/runs', payload);
        toast('Прогон создан', 'success');
        modal.close();
        window.dispatchEvent(new Event('gqlcov:refresh'));
      } catch (error) {
        errorNode.textContent = error.message;
      }
    });
  };

  node.querySelector('#btn-new-run')?.addEventListener('click', openCreate);
  node.querySelector('#btn-new-run-empty')?.addEventListener('click', openCreate);

  const applyDates = () => {
    const from = node.querySelector('#runs-from')?.value || '';
    const to = node.querySelector('#runs-to')?.value || '';
    location.hash = href('runs', { from, to });
  };
  node.querySelector('#runs-from')?.addEventListener('change', applyDates);
  node.querySelector('#runs-to')?.addEventListener('change', applyDates);

  return { node };
}
