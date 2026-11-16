import { state } from '../store.js';
import { bar, esc, kindPill, num, pageHead, pct, statusBadge } from '../ui.js';

const KIND_FILTERS = [
  ['', 'все типы'],
  ['OBJECT', 'object'],
  ['INTERFACE', 'interface'],
  ['UNION', 'union'],
  ['INPUT_OBJECT', 'input'],
  ['ENUM', 'enum'],
  ['SCALAR', 'scalar'],
];

const STATUS_FILTERS = [
  ['', 'любой статус'],
  ['covered', 'покрыт полностью'],
  ['partial', 'частично'],
  ['uncovered', 'не покрыт'],
];

export function renderTypes({ params, href }) {
  const types = state.coverage?.types || [];
  const node = document.createElement('div');

  node.innerHTML = `
    ${pageHead(
      'Типы схемы',
      `Всего ${num(types.length)} типов. Клик по строке открывает детализацию и список полей.`,
      `<a class="btn" href="${href('graph')}">Граф</a>`,
    )}
    <div class="row wrap" style="margin-bottom:14px">
      <input class="field-input" data-search placeholder="Поиск по имени типа…" style="min-width:240px" />
      <select class="field-input" data-kind>${KIND_FILTERS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select>
      <select class="field-input" data-status>${STATUS_FILTERS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select>
      <span class="muted small" data-count></span>
    </div>
    <div class="table-wrap">
      <table class="table">
        <thead><tr>
          <th>Тип</th><th>Kind</th><th>Покрытие</th><th class="num">Полей</th><th class="num">Хиты</th><th class="num">Тестов</th><th>Статус</th>
        </tr></thead>
        <tbody></tbody>
      </table>
    </div>`;

  const tbody = node.querySelector('tbody');
  const counter = node.querySelector('[data-count]');
  const search = node.querySelector('[data-search]');
  const kindSelect = node.querySelector('[data-kind]');
  const statusSelect = node.querySelector('[data-status]');

  const draw = () => {
    const query = search.value.trim().toLowerCase();
    const kind = kindSelect.value;
    const status = statusSelect.value;
    const filtered = types.filter((type) => {
      if (query && !type.name.toLowerCase().includes(query)) return false;
      if (kind && type.kind !== kind) return false;
      if (status && type.status !== status) return false;
      return true;
    });
    counter.textContent = `${filtered.length} из ${types.length}`;
    tbody.innerHTML = filtered
      .map((type) => {
        const isComposite = type.kind === 'OBJECT' || type.kind === 'INTERFACE';
        const coverageCell = isComposite
          ? `<div class="bar-row" style="max-width:190px">${bar(type.percent, { slim: true })}<span class="num">${pct(type.percent)}</span></div>`
          : '<span class="dim">—</span>';
        const statusCell = isComposite
          ? statusBadge(type.status)
          : type.status === 'covered'
            ? '<span class="status covered">затронут</span>'
            : '<span class="status empty">не затронут</span>';
        return `<tr class="clickable" data-name="${esc(type.name)}">
          <td>
            <div class="row-title mono">${esc(type.name)}${type.isRoot ? ' <span class="pill kind UNION">root</span>' : ''}</div>
            ${type.description ? `<div class="row-sub truncate">${esc(type.description)}</div>` : ''}
          </td>
          <td>${kindPill(type.kind)}</td>
          <td>${coverageCell}</td>
          <td class="num">${isComposite ? `${num(type.fieldsCovered)} / ${num(type.fieldsCount)}` : '—'}</td>
          <td class="num">${num(type.hits)}</td>
          <td class="num">${num(type.testCount)}</td>
          <td>${statusCell}</td>
        </tr>`;
      })
      .join('');
    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="muted">Ничего не найдено</td></tr>';
    }
    tbody.querySelectorAll('tr[data-name]').forEach((row) => {
      row.addEventListener('click', () => {
        location.hash = href('type', { name: row.dataset.name });
      });
    });
  };

  search.addEventListener('input', draw);
  kindSelect.addEventListener('change', draw);
  statusSelect.addEventListener('change', draw);
  if (params.get('status')) statusSelect.value = params.get('status');
  draw();

  return { node };
}

export function renderType({ params, href }) {
  const name = params.get('name') || '';
  const coverageType = (state.coverage?.types || []).find((type) => type.name === name);
  const node = document.createElement('div');

  if (!coverageType) {
    node.innerHTML = `
      ${pageHead('Тип не найден', `В активной схеме нет типа <span class="mono">${esc(name)}</span>.`, `<a class="btn" href="${href('types')}">К списку типов</a>`)}
      <div class="empty"><strong>Проверьте имя типа</strong>Возможно, схема была обновлена — обновите страницу.</div>`;
    return { node };
  }

  const fields = [...(coverageType.fields || [])].sort((a, b) => Number(a.covered) - Number(b.covered) || a.name.localeCompare(b.name));
  const testsMap = new Map((state.coverage?.tests || []).map((test) => [test.key, test.name]));
  const typeTestKeys = Object.keys(coverageType.tests || {});

  const edgesOut = (state.schema?.edges || []).filter((edge) => edge.from === name);
  const edgesIn = (state.schema?.edges || []).filter((edge) => edge.to === name);

  node.innerHTML = `
    ${pageHead(
      `<span class="mono">${esc(name)}</span>`,
      coverageType.description ? esc(coverageType.description) : `Тип схемы: ${coverageType.kind}`,
      `<a class="btn ghost" href="${href('graph')}">Показать на графе</a>
       <a class="btn ghost" href="${href('fields', { type: name })}">Только поля типа</a>`,
    )}

    <div class="grid cols-4">
      <div class="card kpi"><div class="kpi-value">${pct(coverageType.percent)}</div><div class="kpi-label">покрытие полей</div>
        <div class="mt-8">${bar(coverageType.percent)}</div></div>
      <div class="card kpi"><div class="kpi-value">${num(coverageType.fieldsCovered)}<small>/ ${num(coverageType.fieldsCount)}</small></div>
        <div class="kpi-label">полей покрыто</div>${statusBadge(coverageType.status)}</div>
      <div class="card kpi"><div class="kpi-value">${num(coverageType.hits)}</div><div class="kpi-label">обращений к типу</div>
        <div class="kpi-hint">${kindPill(coverageType.kind)}</div></div>
      <div class="card kpi"><div class="kpi-value">${num(typeTestKeys.length)}</div><div class="kpi-label">тестов затронуло</div>
        <div class="chips mt-8">${typeTestKeys
          .slice(0, 3)
          .map((key) => `<span class="chip">${esc(testsMap.get(key) || key)}</span>`)
          .join('')}</div></div>
    </div>

    <div class="card mt-16">
      <div class="card-head"><span class="card-title">Поля</span>
        <span class="card-hint">непокрытые — сверху</span></div>
      ${
        fields.length
          ? `<div class="table-wrap"><table class="table">
              <thead><tr><th>Поле</th><th>Тип</th><th>Покрытие</th><th class="num">Хиты</th><th class="num">Тесты</th><th>Аргументы</th></tr></thead>
              <tbody>${fields
                .map(
                  (field) => `<tr>
                    <td><span class="mono ${field.covered ? '' : 'uncovered-key'}">${esc(field.name)}</span>
                      ${field.deprecated ? '<span class="pill kind UNION">deprecated</span>' : ''}</td>
                    <td class="mono dim">${esc(field.type)}</td>
                    <td style="min-width:150px">${field.covered ? bar(100, { slim: true }) : bar(0, { slim: true })}</td>
                    <td class="num">${num(field.hits)}</td>
                    <td class="num">${num(field.testCount)}</td>
                    <td><div class="chips">${
                      field.args.length
                        ? field.args
                            .map(
                              (arg) =>
                                `<span class="chip arg ${arg.covered ? 'covered' : 'uncovered'}" title="${esc(arg.type)}${arg.hits ? ` · ${arg.hits} обращений` : ''}">${esc(arg.name)}</span>`,
                            )
                            .join('')
                        : '<span class="dim small">—</span>'
                    }</div></td>
                  </tr>`,
                )
                .join('')}</tbody></table></div>`
          : '<div class="muted">У этого типа нет полей (union, enum или scalar).</div>'
      }
    </div>

    <div class="grid cols-2 mt-16">
      <div class="card">
        <div class="card-head"><span class="card-title">Исходящие связи</span></div>
        <div class="chips">${
          edgesOut.length
            ? edgesOut
                .slice(0, 40)
                .map((edge) => `<a class="chip" href="${href('type', { name: edge.to })}">${esc(edge.field)} → ${esc(edge.to)}</a>`)
                .join('')
            : '<span class="dim small">нет</span>'
        }</div>
      </div>
      <div class="card">
        <div class="card-head"><span class="card-title">Входящие связи</span></div>
        <div class="chips">${
          edgesIn.length
            ? edgesIn
                .slice(0, 40)
                .map((edge) => `<a class="chip" href="${href('type', { name: edge.from })}">${esc(edge.from)}.${esc(edge.field)} →</a>`)
                .join('')
            : '<span class="dim small">нет</span>'
        }</div>
      </div>
    </div>`;

  return { node };
}
