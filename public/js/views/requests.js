import { api } from '../api.js';
import { state } from '../store.js';
import { debounce, esc, fmtDuration, num, openModal, pageHead, toast } from '../ui.js';

export async function renderRequests({ params, href }) {
  const runId = state.filters.run || '';
  let status = params.get('status') || '';
  let query = params.get('q') || '';
  let offset = 0;
  const limit = 50;

  const node = document.createElement('div');
  node.innerHTML = `
    ${pageHead(
      'Журнал запросов',
      `Каждый запрос через прокси: AST-разбор, затронутые поля, тест и прогон.${runId ? ` Срез: <span class="mono">${esc(runId)}</span>` : ''}`,
      `${runId ? `<a class="btn ghost" href="${href('overview', { run: '' })}">Сбросить прогон</a>` : ''}
       <a class="btn ghost" href="${href('runs')}">Прогоны</a>`,
    )}
    <div class="row wrap" style="margin-bottom:14px">
      <input class="field-input" data-search placeholder="Поиск по запросу, операции, тесту…" style="min-width:280px" value="${esc(query)}" />
      <select class="field-input" data-status>
        <option value="">любой статус</option>
        <option value="ok"${status === 'ok' ? ' selected' : ''}>успешные</option>
        <option value="error"${status === 'error' ? ' selected' : ''}>с ошибками</option>
      </select>
      <span class="muted small" data-count></span>
    </div>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Время</th><th>Операция</th><th>Статус</th><th class="num">Длительность</th><th>Тест</th><th>Прогон</th><th class="num">Полей</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <div class="row mt-16" style="justify-content:space-between">
      <span class="muted small" data-footer></span>
      <button class="btn small" data-more>Показать ещё</button>
    </div>`;

  const tbody = node.querySelector('tbody');
  const counter = node.querySelector('[data-count]');
  const footer = node.querySelector('[data-footer]');
  const more = node.querySelector('[data-more]');
  const searchInput = node.querySelector('[data-search]');
  const statusSelect = node.querySelector('[data-status]');
  let loaded = 0;
  let lastBatch = 0;

  const load = async (reset = false) => {
    if (reset) {
      offset = 0;
      tbody.innerHTML = '';
      loaded = 0;
    }
    const search = new URLSearchParams();
    if (runId) search.set('run', runId);
    if (status) search.set('status', status);
    if (query) search.set('q', query);
    search.set('limit', String(limit));
    search.set('offset', String(offset));
    more.disabled = true;
    more.textContent = 'Загрузка…';
    try {
      const data = await api(`/api/executions?${search.toString()}`);
      lastBatch = data.items.length;
      loaded += data.items.length;
      offset += data.items.length;
      tbody.insertAdjacentHTML('beforeend', data.items.map(rowHtml).join(''));
      bindRows();
      if (loaded === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="muted">Запросов пока нет. Они появятся после первого запроса через <span class="mono">/proxy</span>.</td></tr>';
      }
      counter.textContent = `${loaded}${data.total !== null ? ` из ${data.total}` : '+'} запросов`;
      footer.textContent = lastBatch === limit ? 'Есть ещё записи' : 'Это все записи в выбранном срезе';
      more.disabled = lastBatch < limit;
      more.textContent = 'Показать ещё';
    } catch (error) {
      more.textContent = 'Повторить';
      more.disabled = false;
      toast(error.message, 'error');
    }
  };

  const rowHtml = (item) => {
    const statusText = Number(item.status) || 0;
    const ok = item.ok && statusText >= 200 && statusText < 400;
    return `<tr class="clickable" data-id="${esc(item.id)}">
      <td class="muted nowrap" title="${esc(item.at)}">${new Date(item.at).toLocaleString('ru-RU')}</td>
      <td><span class="mono">${esc(item.operationType || 'query')}</span> ${item.operationName ? `<span class="dim">${esc(item.operationName)}</span>` : ''}
        <div class="row-sub nowrap-ellipsis" style="max-width:360px">${esc(item.queryPreview || '')}</div></td>
      <td><span class="status ${ok ? 'covered' : 'uncovered'}">${statusText || 'net'}</span></td>
      <td class="num">${fmtDuration(item.durationMs)}</td>
      <td class="muted">${esc(item.test?.name || item.test?.key || '—')}</td>
      <td class="mono dim nowrap">${esc(item.runId || '—')}</td>
      <td class="num">${num(item.fieldCount)}</td>
    </tr>`;
  };

  const bindRows = () => {
    tbody.querySelectorAll('tr[data-id]').forEach((row) => {
      row.addEventListener('click', () => void openExecution(row.dataset.id));
    });
  };

  const openExecution = async (id) => {
    try {
      const data = await api(`/api/executions/${encodeURIComponent(id)}`);
      const exec = data.execution;
      const analysis = exec.analysis || {};
      const ok = exec.ok && Number(exec.status) >= 200 && Number(exec.status) < 400;
      openModal({
        title: `Запрос · ${esc(exec.operationType || 'query')}${exec.operationName ? ` ${esc(exec.operationName)}` : ''}`,
        subtitle: `${esc(exec.runId)} · ${new Date(exec.at).toLocaleString('ru-RU')} · ${esc(exec.service || 'default')}`,
        width: 940,
        body: `
          <div class="grid cols-4">
            <div class="card kpi"><div class="kpi-value"><span class="status ${ok ? 'covered' : 'uncovered'}">${exec.status}</span></div><div class="kpi-label">HTTP статус</div></div>
            <div class="card kpi"><div class="kpi-value">${fmtDuration(exec.durationMs)}</div><div class="kpi-label">длительность</div></div>
            <div class="card kpi"><div class="kpi-value">${num(analysis.fieldCount)}</div><div class="kpi-label">полей затронуто</div></div>
            <div class="card kpi"><div class="kpi-value">${num(analysis.maxDepth || 0)}</div><div class="kpi-label">глубина</div></div>
          </div>
          ${
            exec.errors?.length
              ? `<div class="card"><div class="card-head"><span class="card-title red">Ошибки</span></div>
                  <pre class="code small">${esc(exec.errors.map((error) => `[${error.code || 'ERROR'}] ${error.message}`).join('\n'))}</pre></div>`
              : ''
          }
          <div class="form-row"><label>Query</label><pre class="code">${esc(exec.query || '')}</pre></div>
          ${
            exec.variables
              ? `<div class="form-row"><label>Variables</label><pre class="code small">${esc(JSON.stringify(exec.variables, null, 2))}</pre></div>`
              : ''
          }
          <div class="form-row"><label>Затронутые поля (${(analysis.fields || []).length})</label>
            <div class="chips">${(analysis.fields || [])
              .slice(0, 120)
              .map((key) => `<span class="chip covered">${esc(key)}</span>`)
              .join('')}</div></div>
          ${
            (analysis.args || []).length
              ? `<div class="form-row"><label>Аргументы (${analysis.args.length})</label>
                  <div class="chips">${analysis.args.map((key) => `<span class="chip">${esc(key)}</span>`).join('')}</div></div>`
              : ''
          }
          ${
            exec.responsePreview
              ? `<div class="form-row"><label>Фрагмент ответа</label><pre class="code small">${esc(exec.responsePreview)}</pre></div>`
              : ''
          }`,
        footer: `<button class="btn ghost" data-close>Закрыть</button>`,
      });
    } catch (error) {
      toast(error.message, 'error');
    }
  };

  searchInput.addEventListener(
    'input',
    debounce(() => {
      query = searchInput.value.trim();
      void load(true);
    }, 320),
  );
  statusSelect.addEventListener('change', () => {
    status = statusSelect.value;
    void load(true);
  });
  more.addEventListener('click', () => void load(false));

  await load(true);
  return { node };
}
