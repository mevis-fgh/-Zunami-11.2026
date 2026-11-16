import { api, getAdminToken, getProxyKey, post, setAdminToken, setProxyKey } from './api.js';
import { state, ensureBase, ensureData, filtersFromParams, invalidateAll } from './store.js';
import { esc, num, openModal, pct, toast } from './ui.js';
import { renderCompare } from './views/compare.js';
import { renderDashboard } from './views/dashboard.js';
import { renderFields } from './views/fields.js';
import { renderGraph } from './views/graph.js';
import { renderRequests } from './views/requests.js';
import { renderRuns } from './views/runs.js';
import { renderTimeline } from './views/timeline.js';
import { renderType, renderTypes } from './views/types.js';

const NAV = [
  { route: 'overview', label: 'Обзор', icon: '◈' },
  { route: 'graph', label: 'Граф схемы', icon: '⬡' },
  { route: 'types', label: 'Типы', icon: '▤' },
  { route: 'fields', label: 'Поля', icon: '☰' },
  { route: 'timeline', label: 'Динамика', icon: '◔' },
  { route: 'runs', label: 'Прогоны', icon: '⏱' },
  { route: 'requests', label: 'Запросы', icon: '⇄' },
  { route: 'compare', label: 'Сравнение', icon: '⇋' },
];

const VIEWS = {
  overview: renderDashboard,
  graph: renderGraph,
  types: renderTypes,
  type: renderType,
  fields: renderFields,
  timeline: renderTimeline,
  runs: renderRuns,
  requests: renderRequests,
  compare: renderCompare,
};

let current = { cleanup: null };

/* ------------------------------ routing ------------------------------ */

function parseHash() {
  const raw = location.hash.replace(/^#/, '');
  const [path, query = ''] = raw.split('?');
  const segments = path.split('/').filter(Boolean);
  return { route: segments[0] || 'overview', segments, params: new URLSearchParams(query) };
}

function setHash(route, params = {}) {
  const search = params instanceof URLSearchParams ? params : new URLSearchParams(params);
  const next = `#/${route}${search.toString() ? `?${search.toString()}` : ''}`;
  if (location.hash === next) void renderRoute();
  else location.hash = next;
}

function href(route, extra = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(state.filters || {})) if (value) params.set(key, value);
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === null || value === '') params.delete(key);
    else params.set(key, value);
  }
  const search = params.toString();
  return `#/${route}${search ? `?${search}` : ''}`;
}

function updateFilter(key, value) {
  const { route, params } = parseHash();
  if (value) params.set(key, value);
  else params.delete(key);
  if (key === 'run' && value) params.delete('schemaId');
  setHash(route, params);
}

/* ------------------------------ chrome ------------------------------ */

function renderSidebar() {
  const host = document.getElementById('sidebar');
  if (!host) return;
  const active = parseHash().route;
  host.innerHTML = `
    <div class="sidebar-title">Навигация</div>
    ${NAV.map(
      (item) => `<a class="nav-item${item.route === active ? ' active' : ''}" href="${href(item.route)}" data-route="${item.route}">
        <span class="nav-icon">${item.icon}</span><span>${item.label}</span>
        ${item.route === 'runs' && state.runTotal ? `<span class="nav-count">${num(state.runTotal)}</span>` : ''}
      </a>`,
    ).join('')}
    <div class="sidebar-sep"></div>
    <div class="sidebar-title">Легенда</div>
    <div class="legend">
      <div class="legend-row"><span class="legend-swatch covered"></span>покрыто тестами</div>
      <div class="legend-row"><span class="legend-swatch partial"></span>покрыто частично</div>
      <div class="legend-row"><span class="legend-swatch uncovered"></span>не покрыто</div>
      <div class="legend-row"><span class="legend-swatch none"></span>нет полей</div>
    </div>
    <div class="sidebar-footer">
      <div>GraphQL Coverage Proxy <span class="mono">v${esc(state.config?.version || '1.0.0')}</span></div>
      <div class="mt-8"><a href="/healthz" target="_blank" rel="noreferrer">healthz</a> · <a href="#" id="nav-api">API</a></div>
    </div>`;
  const apiLink = host.querySelector('#nav-api');
  apiLink?.addEventListener('click', (event) => {
    event.preventDefault();
    openApiHelp();
  });
}

function renderFilterBar(filters) {
  const host = document.getElementById('filterbar');
  if (!host) return;
  const summary = state.coverage?.summary || {};
  const runs = state.runs || [];
  const facets = state.facets || {};

  const option = (value, label, selected) =>
    `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`;

  const runOptions = runs
    .map((run) => option(run.runId, `${run.name || run.runId} · ${run.branch || '—'} · ${pct(run.percent)}`, filters.run))
    .join('');
  const branchOptions = (facets.branches || []).map((branch) => option(branch, branch, filters.branch)).join('');
  const teamOptions = (facets.teams || []).map((team) => option(team, team, filters.team)).join('');
  const envOptions = (facets.envs || []).map((env) => option(env, env, filters.env)).join('');

  host.innerHTML = `
    <label class="filter"><span>Прогон</span>
      <select id="filter-run"><option value="">все прогоны</option>${runOptions}</select>
    </label>
    <label class="filter"><span>Ветка</span>
      <select id="filter-branch"><option value="">все</option>${branchOptions}</select>
    </label>
    <label class="filter"><span>Команда</span>
      <select id="filter-team"><option value="">все</option>${teamOptions}</select>
    </label>
    <label class="filter"><span>Окружение</span>
      <select id="filter-env"><option value="">все</option>${envOptions}</select>
    </label>
    <div class="spacer"></div>
    <span class="pill" title="Покрытие полей в текущем срезе">
      <span class="dot" style="background:${(summary.fieldsPercent || 0) >= 80 ? '#22c55e' : (summary.fieldsPercent || 0) >= 40 ? '#f59e0b' : '#ef4444'}"></span>
      ${pct(summary.fieldsPercent)} · ${num(summary.fieldsCovered)}/${num(summary.fieldsTotal)} полей
    </span>
    <button class="btn ghost small" id="filter-reset">Сбросить</button>`;

  const bind = (id, key) => {
    const element = host.querySelector(id);
    element?.addEventListener('change', () => updateFilter(key, element.value));
  };
  bind('#filter-run', 'run');
  bind('#filter-branch', 'branch');
  bind('#filter-team', 'team');
  bind('#filter-env', 'env');

  host.querySelector('#filter-reset')?.addEventListener('click', () => {
    const { route, params } = parseHash();
    for (const key of ['run', 'branch', 'team', 'env', 'from', 'to']) params.delete(key);
    setHash(route, params);
  });
}

function updateChrome(route) {
  document.querySelectorAll('.nav-item').forEach((node) => {
    node.classList.toggle('active', node.dataset.route === route);
  });
  const pill = document.getElementById('schema-pill-text');
  if (pill) {
    pill.textContent = state.schema
      ? `${state.schema.name} · ${state.schema.stats?.types || 0} типов · ${state.schema.stats?.fields || 0} полей`
      : 'схема не загружена';
  }
  const dot = document.querySelector('#schema-pill .dot');
  if (dot) dot.style.background = state.schema ? '#22c55e' : '#ef4444';
}

/* ------------------------------ render ------------------------------ */

function skeleton() {
  const host = document.getElementById('view');
  host.innerHTML = `
    <div class="page-head"><div><div class="skeleton" style="width:280px;height:26px;border-radius:8px"></div>
    <div class="skeleton mt-8" style="width:420px;height:14px;border-radius:6px"></div></div></div>
    <div class="grid cols-4">
      ${'<div class="card skeleton skeleton-card"></div>'.repeat(4)}
    </div>
    <div class="card skeleton skeleton-block mt-16"></div>`;
}

function renderError(error) {
  const host = document.getElementById('view');
  const isAuth = error?.status === 401;
  host.innerHTML = `
    <div class="page-head"><div><h2 class="page-title">Не удалось загрузить данные</h2>
      <p class="page-sub">${esc(error?.message || error)}</p></div>
      <div class="page-actions"><button class="btn" id="err-retry">Повторить</button>
      ${isAuth ? '<button class="btn" id="err-settings">Настройки доступа</button>' : ''}</div></div>
    ${error?.payload ? `<div class="card"><pre class="code small">${esc(JSON.stringify(error.payload, null, 2))}</pre></div>` : ''}`;
  host.querySelector('#err-retry')?.addEventListener('click', () => renderRoute());
  host.querySelector('#err-settings')?.addEventListener('click', openSettingsModal);
}

async function renderRoute() {
  const { route, segments, params } = parseHash();
  const filters = filtersFromParams(params);
  const view = VIEWS[route] || VIEWS.overview;

  if (current.cleanup) {
    try {
      current.cleanup();
    } catch {
      /* ignore cleanup errors */
    }
    current = { cleanup: null };
  }

  skeleton();
  try {
    await ensureBase();
    await ensureData(filters);
    renderSidebar();
    renderFilterBar(filters);
    updateChrome(route);

    const result = await view({
      params,
      filters,
      segments,
      go: (nextRoute, extra) => setHash(nextRoute, extra || {}),
      href,
    });
    const node = result?.node || result;
    current = { cleanup: result?.cleanup || null };
    const host = document.getElementById('view');
    host.innerHTML = '';
    host.append(node);
    host.focus({ preventScroll: true });
  } catch (error) {
    renderError(error);
    if (error?.status !== 401) console.error(error);
  }
}

/* ------------------------------ modals ------------------------------ */

async function openSchemaModal() {
  const modal = openModal({
    title: 'Схема GraphQL',
    subtitle: 'Introspection, загрузка SDL, переключение снапшотов',
    width: 880,
    body: '<div class="skeleton skeleton-card"></div>',
    footer: '<button class="btn ghost" data-close>Закрыть</button>',
  });

  const render = async () => {
    const [schemasResponse, schemaResponse] = await Promise.all([api('/api/schemas'), api('/api/schema')]);
    const schemas = schemasResponse.items || [];
    const active = schemaResponse.schema;

    const rows = schemas
      .map(
        (schema) => `<tr>
          <td>${schema.active ? '<span class="status covered">активна</span>' : '<span class="status empty">—</span>'}</td>
          <td><div class="row-title">${esc(schema.name)}</div>
            <div class="row-sub mono">${esc(schema.id)}</div></td>
          <td><span class="pill kind ${schema.source === 'introspection' ? 'INTERFACE' : 'ENUM'}">${esc(schema.source)}</span></td>
          <td class="num">${num(schema.stats?.types)}</td>
          <td class="num">${num(schema.stats?.fields)}</td>
          <td class="nowrap muted">${new Date(schema.createdAt).toLocaleString('ru-RU')}</td>
          <td class="tight">
            ${schema.active ? '' : `<button class="btn small" data-activate="${esc(schema.id)}">Активировать</button>`}
            <button class="btn small ghost danger" data-delete="${esc(schema.id)}" title="Удалить снапшот">✕</button>
          </td>
        </tr>`,
      )
      .join('');

    modal.element.querySelector('.modal-body').innerHTML = `
      <div class="stack">
        <div class="row wrap">
          <span class="pill">${active ? esc(active.name) : 'схема не загружена'}</span>
          <span class="muted small">${active ? `${num(active.stats?.fields)} полей · ${num(active.stats?.types)} типов · ${esc(active.service || 'default')}` : ''}</span>
        </div>
        ${active ? '<details><summary class="muted small" style="cursor:pointer">Показать SDL</summary><pre class="code small mt-8">' + esc(active.sdl || '').slice(0, 20000) + '</pre></details>' : ''}
        <div class="table-wrap">
          <table class="table"><thead><tr><th></th><th>Схема</th><th>Источник</th><th class="num">Типы</th><th class="num">Поля</th><th>Создана</th><th></th></tr></thead>
            <tbody>${rows || '<tr><td colspan="7" class="muted">Схем пока нет — загрузите SDL или выполните introspection.</td></tr>'}</tbody></table>
        </div>
      </div>
      <div class="grid cols-2">
        <div class="card">
          <div class="card-head"><span class="card-title">Introspection</span></div>
          <div class="form-row">
            <label for="introspect-endpoint">URL GraphQL-сервера</label>
            <input class="input mono" id="introspect-endpoint" placeholder="https://api.example.com/graphql"
              value="${esc(active?.endpoint || state.config?.schema?.introspectUrl || '')}" />
            <div class="hint">Сервис выполнит стандартный introspection-запрос и сохранит снапшот схемы.</div>
          </div>
          <div class="row mt-8">
            <button class="btn primary" id="btn-introspect">Загрузить по introspection</button>
            <span class="small muted" id="introspect-status"></span>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><span class="card-title">Загрузить SDL</span></div>
          <div class="form-row">
            <label for="sdl-input">SDL-файл или текст</label>
            <textarea class="textarea" id="sdl-input" placeholder="type Query { hello: String }"></textarea>
            <div class="row">
              <input type="file" id="sdl-file" accept=".graphql,.gql,.txt" class="small muted" />
            </div>
          </div>
          <div class="row mt-8">
            <button class="btn primary" id="btn-upload-sdl">Загрузить SDL</button>
            <span class="small muted" id="sdl-status"></span>
          </div>
        </div>
      </div>`;

    modal.element.querySelectorAll('[data-activate]').forEach((button) =>
      button.addEventListener('click', async () => {
        try {
          await post(`/api/schema/${encodeURIComponent(button.dataset.activate)}/activate`);
          invalidateAll();
          toast('Схема активирована', 'success');
          await render();
          await renderRoute();
        } catch (error) {
          toast(error.message, 'error');
        }
      }),
    );

    modal.element.querySelectorAll('[data-delete]').forEach((button) =>
      button.addEventListener('click', async () => {
        if (!confirm('Удалить снапшот схемы?')) return;
        try {
          await api(`/api/schema/${encodeURIComponent(button.dataset.delete)}`, { method: 'DELETE' });
          invalidateAll();
          toast('Снапшот удалён', 'success');
          await render();
          await renderRoute();
        } catch (error) {
          toast(error.message, 'error');
        }
      }),
    );

    modal.element.querySelector('#sdl-file')?.addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      modal.element.querySelector('#sdl-input').value = await file.text();
    });

    modal.element.querySelector('#btn-upload-sdl')?.addEventListener('click', async () => {
      const status = modal.element.querySelector('#sdl-status');
      const sdl = modal.element.querySelector('#sdl-input').value;
      if (!sdl.trim()) {
        status.textContent = 'SDL пустой';
        return;
      }
      status.textContent = 'Загружаем…';
      try {
        const result = await post('/api/schema/sdl', { sdl });
        toast(`Схема загружена: ${result.schema.stats.fields} полей`, 'success');
        invalidateAll();
        await render();
        await renderRoute();
      } catch (error) {
        status.textContent = error.message;
        toast(error.message, 'error');
      }
    });

    modal.element.querySelector('#btn-introspect')?.addEventListener('click', async () => {
      const status = modal.element.querySelector('#introspect-status');
      const endpoint = modal.element.querySelector('#introspect-endpoint').value.trim();
      if (!endpoint) {
        status.textContent = 'Укажите URL';
        return;
      }
      status.textContent = 'Выполняем introspection…';
      try {
        const result = await post('/api/schema/introspect', { endpoint });
        toast(`Схема загружена: ${result.schema.stats.fields} полей`, 'success');
        invalidateAll();
        await render();
        await renderRoute();
      } catch (error) {
        status.textContent = error.message;
        toast(error.message, 'error');
      }
    });
  };

  try {
    await render();
  } catch (error) {
    modal.element.querySelector('.modal-body').innerHTML = `<div class="form-error">${esc(error.message)}</div>`;
  }
}

function openSettingsModal() {
  const proxyUrl = `${location.origin}/proxy`;
  const modal = openModal({
    title: 'Настройки доступа',
    subtitle: 'Ключи хранятся только в localStorage этого браузера',
    width: 620,
    body: `
      <div class="form-row">
        <label for="admin-token">Admin token</label>
        <input class="input mono" id="admin-token" placeholder="значение ADMIN_TOKEN" value="${esc(getAdminToken())}" />
        <div class="hint">Нужен для загрузки схем, ingest и удаления прогонов, если на сервере задан ADMIN_TOKEN.</div>
      </div>
      <div class="form-row">
        <label for="proxy-key">Proxy API key</label>
        <input class="input mono" id="proxy-key" placeholder="значение PROXY_API_KEY" value="${esc(getProxyKey())}" />
        <div class="hint">Передаётся тестам в заголовке <span class="mono">x-proxy-key</span> при включённой авторизации прокси.</div>
      </div>
      <div class="card">
        <div class="card-head"><span class="card-title">Как подключить тесты</span></div>
        <p class="muted small">Замените базовый URL GraphQL в тестах на адрес прокси — код тестов менять не нужно.</p>
        <pre class="code small">GRAPHQL_URL=${proxyUrl}
# опционально: контекст прогона
x-run-id: ci-1234
x-branch: main
x-team: qa
x-environment: staging
x-test-id: checkout/create</pre>
        <div class="row mt-8">
          <button class="btn small" id="copy-proxy">Скопировать URL</button>
        </div>
      </div>`,
    footer: '<button class="btn ghost" data-close>Отмена</button><button class="btn primary" id="save-settings">Сохранить</button>',
  });

  modal.element.querySelector('#save-settings')?.addEventListener('click', () => {
    setAdminToken(modal.element.querySelector('#admin-token').value.trim());
    setProxyKey(modal.element.querySelector('#proxy-key').value.trim());
    toast('Настройки сохранены', 'success');
    modal.close();
    void renderRoute();
  });
  modal.element.querySelector('#copy-proxy')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(proxyUrl);
      toast('URL скопирован', 'success');
    } catch {
      toast(proxyUrl);
    }
  });
}

function openApiHelp() {
  openModal({
    title: 'API',
    subtitle: 'REST-эндпоинты сервиса',
    width: 760,
    body: `<pre class="code">GET  /healthz                       состояние сервиса
POST /proxy                         GraphQL-прокси (профиль прогона — в заголовках)
GET  /api/schema                    активная схема (типы, связи)
POST /api/schema/sdl                загрузка SDL { sdl }
POST /api/schema/introspect        { endpoint } — introspection
POST /api/schema/:id/activate       переключить снапшот
GET  /api/coverage                  покрытие: ?run=&branch=&team=&env=&from=&to=
GET  /api/coverage/type/:name       детализация типа
GET  /api/coverage/timeline         динамика по прогонам
GET  /api/coverage/compare          ?base=<run>&head=<run>
GET  /api/coverage/gaps             непокрытые поля
GET  /api/coverage/export           ?format=csv|json&what=fields|types|operations|gaps
GET  /api/coverage/badge            SVG-бейдж для CI
GET  /api/runs                      список прогонов + фасеты
POST /api/runs                      создать прогон вручную
GET  /api/executions                журнал запросов: ?run=&status=&q=
POST /api/ingest                    загрузить покрытие из CI без прокси
GET  /api/state/export              бэкап состояния (admin)
POST /api/state/import              восстановление (admin)</pre>`,
    footer: '<button class="btn ghost" data-close>Закрыть</button>',
  });
}

/* ------------------------------ boot ------------------------------ */

async function boot() {
  try {
    await ensureBase();
    renderSidebar();
    renderFilterBar(filtersFromParams(parseHash().params));
    updateChrome(parseHash().route);
    if (!state.schema) showOnboarding();
    else await renderRoute();
  } catch (error) {
    renderError(error);
  }
}

function showOnboarding() {
  const host = document.getElementById('view');
  host.innerHTML = `
    <div class="page-head"><div>
      <h2 class="page-title">Подключите GraphQL-схему</h2>
      <p class="page-sub">Сервис ещё не знает схему. Загрузите SDL или выполните introspection у вашего GraphQL-сервера — после этого прокси начнёт считать покрытие.</p>
    </div></div>
    <div class="grid cols-3">
      <div class="card">
        <div class="card-head"><span class="card-title">1 · Introspection</span></div>
        <p class="muted">Укажите URL GraphQL-эндпоинта, сервис сам заберёт схему.</p>
        <button class="btn primary mt-16" id="onb-introspect">Загрузить по introspection</button>
      </div>
      <div class="card">
        <div class="card-head"><span class="card-title">2 · SDL</span></div>
        <p class="muted">Загрузите .graphql-файл или вставьте SDL вручную.</p>
        <button class="btn mt-16" id="onb-sdl">Загрузить SDL</button>
      </div>
      <div class="card">
        <div class="card-head"><span class="card-title">3 · Демо</span></div>
        <p class="muted">Посмотреть интерфейс на демо-схеме магазина и 4 прогонах.</p>
        <button class="btn mt-16" id="onb-demo">Загрузить демо-данные</button>
      </div>
    </div>
    <div class="card mt-16">
      <div class="card-head"><span class="card-title">Прокси уже готов</span></div>
      <p class="muted">Направьте тесты на <span class="mono">${esc(location.origin)}/proxy</span> — запросы будут прозрачно уходить на целевой GraphQL-сервер, а покрытие — собираться здесь.</p>
    </div>`;
  host.querySelector('#onb-introspect')?.addEventListener('click', openSchemaModal);
  host.querySelector('#onb-sdl')?.addEventListener('click', openSchemaModal);
  host.querySelector('#onb-demo')?.addEventListener('click', async () => {
    try {
      const result = await post('/api/demo/seed');
      if (result.seeded) {
        invalidateAll();
        toast('Демо-данные загружены', 'success');
        await ensureBase(true);
        await renderRoute();
      } else {
        toast(result.reason || 'Демо недоступно');
      }
    } catch (error) {
      toast(error.message, 'error');
    }
  });
}

window.addEventListener('hashchange', () => void renderRoute());

window.addEventListener('gqlcov:refresh', async () => {
  invalidateAll();
  try {
    await ensureBase(true);
    await renderRoute();
  } catch (error) {
    toast(error.message, 'error');
  }
});

document.getElementById('btn-refresh')?.addEventListener('click', async () => {
  try {
    const { params } = parseHash();
    await ensureData(filtersFromParams(params), true);
    await ensureBase(true);
    toast('Данные обновлены');
    await renderRoute();
  } catch (error) {
    toast(error.message, 'error');
  }
});
document.getElementById('btn-schema')?.addEventListener('click', openSchemaModal);
document.getElementById('btn-settings')?.addEventListener('click', openSettingsModal);

document.addEventListener('keydown', (event) => {
  if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
    const search = document.querySelector('.graph-toolbar input, [data-search]');
    if (search) {
      event.preventDefault();
      search.focus();
    }
  }
});

void boot();
