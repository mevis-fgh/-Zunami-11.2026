import { queryFromFilters, state } from '../store.js';
import { bar, esc, num, pageHead, pct, statusBadge } from '../ui.js';

const SORTS = [
  ['hits', 'по хитам'],
  ['name', 'по имени'],
  ['type', 'по типу'],
  ['coverage', 'сначала непокрытые'],
  ['depth', 'по глубине'],
];

const STATUS = [
  ['', 'любой статус'],
  ['covered', 'покрытые'],
  ['uncovered', 'непокрытые'],
];

export function renderFields({ params, href }) {
  const types = state.coverage?.types || [];
  const fields = types.flatMap((type) => (type.fields || []).map((field) => ({ ...field, typeName: type.name, typeKind: type.kind })));
  const node = document.createElement('div');
  const filtersQuery = queryFromFilters(state.filters);

  let limit = 120;
  let sort = params.get('sort') || 'hits';
  let status = params.get('status') || '';
  let typeFilter = params.get('type') || '';
  let query = params.get('q') || '';

  node.innerHTML = `
    ${pageHead(
      'Поля схемы',
      `Все выходные поля типов. Сортировка по частоте помогает увидеть, что реально гоняют тесты.`,
      `<a class="btn" href="/api/coverage/export?format=csv&what=fields${filtersQuery ? `&${filtersQuery}` : ''}">CSV полей</a>
       <a class="btn ghost" href="/api/coverage/export?format=csv&what=gaps${filtersQuery ? `&${filtersQuery}` : ''}">CSV дыр</a>
       <a class="btn ghost" href="${href('graph')}">Граф</a>`,
    )}
    <div class="row wrap" style="margin-bottom:14px">
      <input class="field-input" data-search placeholder="Поиск: тип или поле…" style="min-width:240px" value="${esc(query)}" />
      <select class="field-input" data-type><option value="">все типы</option>${types
        .filter((type) => type.kind === 'OBJECT' || type.kind === 'INTERFACE')
        .map((type) => `<option value="${esc(type.name)}"${type.name === typeFilter ? ' selected' : ''}>${esc(type.name)}</option>`)
        .join('')}</select>
      <select class="field-input" data-status>${STATUS.map(([value, label]) => `<option value="${value}"${value === status ? ' selected' : ''}>${label}</option>`).join('')}</select>
      <select class="field-input" data-sort>${SORTS.map(([value, label]) => `<option value="${value}"${value === sort ? ' selected' : ''}>${label}</option>`).join('')}</select>
      <span class="muted small" data-count></span>
    </div>
    <div class="card">
      <div class="card-head">
        <span class="card-title">Хитмап полей</span>
        <span class="card-hint">яркость — частота обращений, красный — не покрыто, клик — тип</span>
      </div>
      <div class="heatmap" data-heatmap></div>
    </div>
    <div class="table-wrap mt-16">
      <table class="table">
        <thead><tr><th>Поле</th><th>Тип</th><th>Статус</th><th class="num">Хиты</th><th class="num">Тесты</th><th class="num">Аргументы</th><th class="num">Глубина</th><th>Последний раз</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <div class="row mt-16" style="justify-content:space-between">
      <span class="muted small" data-footer></span>
      <button class="btn small" data-more>Показать ещё</button>
    </div>`;

  const searchInput = node.querySelector('[data-search]');
  const typeSelect = node.querySelector('[data-type]');
  const statusSelect = node.querySelector('[data-status]');
  const sortSelect = node.querySelector('[data-sort]');
  const tbody = node.querySelector('tbody');
  const counter = node.querySelector('[data-count]');
  const footer = node.querySelector('[data-footer]');
  const moreButton = node.querySelector('[data-more]');
  const heatmap = node.querySelector('[data-heatmap]');

  const filtered = () => {
    const q = query.trim().toLowerCase();
    let list = fields.filter((field) => {
      if (q && !field.key.toLowerCase().includes(q)) return false;
      if (status === 'covered' && !field.covered) return false;
      if (status === 'uncovered' && field.covered) return false;
      if (typeFilter && field.typeName !== typeFilter) return false;
      return true;
    });
    const comparators = {
      hits: (a, b) => b.hits - a.hits || a.key.localeCompare(b.key),
      name: (a, b) => a.key.localeCompare(b.key),
      type: (a, b) => a.typeName.localeCompare(b.typeName) || a.name.localeCompare(b.name),
      coverage: (a, b) => Number(a.covered) - Number(b.covered) || a.key.localeCompare(b.key),
      depth: (a, b) => (b.depth || 0) - (a.depth || 0) || b.hits - a.hits,
    };
    list = [...list].sort(comparators[sort] || comparators.hits);
    return list;
  };

  const draw = () => {
    const list = filtered();
    counter.textContent = `${list.length} полей`;
    footer.textContent = `Показано ${Math.min(limit, list.length)} из ${list.length}`;
    moreButton.disabled = list.length <= limit;
    const maxHits = Math.max(1, ...list.map((field) => field.hits));
    heatmap.innerHTML = list
      .slice(0, 1500)
      .map((field) => {
        const alpha = field.covered ? (0.16 + 0.84 * Math.min(1, field.hits / maxHits)).toFixed(2) : '0.3';
        const color = field.covered ? `rgba(34,197,94,${alpha})` : 'rgba(239,68,68,0.32)';
        return `<a class="heat-cell" href="${href('type', { name: field.typeName })}" style="background:${color}" title="${esc(field.key)} · ${field.covered ? `${field.hits} хитов` : 'не покрыто'}"></a>`;
      })
      .join('');
    tbody.innerHTML = list
      .slice(0, limit)
      .map(
        (field) => `<tr>
          <td>
            <a class="mono ${field.covered ? '' : 'uncovered-key'}" href="${href('type', { name: field.typeName })}">${esc(field.key)}</a>
            ${field.deprecated ? ' <span class="pill kind UNION">deprecated</span>' : ''}
          </td>
          <td class="mono dim">${esc(field.type)}</td>
          <td>${statusBadge(field.status)}</td>
          <td class="num">${num(field.hits)}</td>
          <td class="num">${num(field.testCount)}</td>
          <td class="num">${field.argsTotal ? `${num(field.argsCovered)} / ${num(field.argsTotal)}` : '—'}</td>
          <td class="num">${field.depth || '—'}</td>
          <td class="muted nowrap">${field.lastSeen ? new Date(field.lastSeen).toLocaleString('ru-RU') : '—'}</td>
        </tr>`,
      )
      .join('');
    if (list.length === 0) tbody.innerHTML = '<tr><td colspan="8" class="muted">Ничего не найдено</td></tr>';
  };

  const syncUrl = () => {
    const next = new URLSearchParams(location.hash.split('?')[1] || '');
    if (status) next.set('status', status);
    else next.delete('status');
    if (typeFilter) next.set('type', typeFilter);
    else next.delete('type');
    if (query) next.set('q', query);
    else next.delete('q');
    if (sort !== 'hits') next.set('sort', sort);
    else next.delete('sort');
    const target = `#/fields${next.toString() ? `?${next.toString()}` : ''}`;
    if (location.hash !== target) history.replaceState(null, '', target);
  };

  searchInput.addEventListener('input', () => {
    query = searchInput.value;
    limit = 120;
    draw();
  });
  typeSelect.addEventListener('change', () => {
    typeFilter = typeSelect.value;
    limit = 120;
    syncUrl();
    draw();
  });
  statusSelect.addEventListener('change', () => {
    status = statusSelect.value;
    limit = 120;
    syncUrl();
    draw();
  });
  sortSelect.addEventListener('change', () => {
    sort = sortSelect.value;
    syncUrl();
    draw();
  });
  moreButton.addEventListener('click', () => {
    limit += 200;
    draw();
  });

  draw();
  return { node };
}
