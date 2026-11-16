import { SchemaGraphCanvas, nodeKindLabel } from '../graph-canvas.js';
import { state } from '../store.js';
import { bar, debounce, esc, hideTooltip, num, pageHead, pct, showTooltip } from '../ui.js';

export function renderGraph({ href }) {
  const coverage = state.coverage;
  const schema = state.schema;
  const node = document.createElement('div');

  if (!schema || !coverage?.types?.length) {
    node.innerHTML = `
      ${pageHead('Граф схемы', 'Как только появится схема, здесь будет интерактивный граф типов и связей.')}
      <div class="empty"><strong>Схема не загружена</strong>Загрузите SDL или выполните introspection.
        <div class="mt-16"><a class="btn primary" href="${href('overview')}">На главную</a></div></div>`;
    return { node };
  }

  const fieldCoverage = new Map();
  for (const type of coverage.types) {
    for (const field of type.fields || []) fieldCoverage.set(field.key, Boolean(field.covered));
  }

  const nodes = coverage.types.map((type) => ({
    id: type.name,
    kind: type.kind,
    status: type.status,
    percent: type.percent,
    fieldsCount: type.fieldsCount,
    isRoot: type.isRoot,
    hits: type.hits,
    description: type.description,
  }));

  const known = new Set(nodes.map((item) => item.id));
  const edges = (schema.edges || [])
    .filter((edge) => known.has(edge.from) && known.has(edge.to))
    .map((edge) => ({
      source: edge.from,
      target: edge.to,
      field: edge.field,
      leaf: Boolean(edge.leaf),
      covered: Boolean(fieldCoverage.get(`${edge.from}.${edge.field}`)),
    }));

  // Пунктирные связи «поле → тип аргумента»: показывают, куда ведут input/enum
  const argKeys = new Set();
  for (const type of coverage.types) {
    for (const field of type.fields || []) {
      for (const arg of field.args || []) {
        const target = arg.namedType || String(arg.type || '').replace(/[\[\]!\s]/g, '');
        const key = `${type.name}.${field.name}.${arg.name}`;
        if (!known.has(target) || argKeys.has(key)) continue;
        argKeys.add(key);
        edges.push({
          source: type.name,
          target,
          field: `${field.name}(${arg.name})`,
          leaf: true,
          arg: true,
          covered: Boolean(arg.covered),
        });
      }
    }
  }

  node.innerHTML = `
    ${pageHead(
      'Граф схемы',
      'Цвет узла — покрытие его полей. Стрелка — поле, которое возвращает другой тип. Наведите на узел, чтобы подсветить связи, кликните — откроется панель.',
      `<a class="btn ghost" href="${href('types')}">Список типов</a>
       <a class="btn ghost" href="${href('fields', { status: 'uncovered' })}">Непокрытые поля</a>`,
    )}
    <div class="graph-page">
      <div class="graph-toolbar">
        <div class="search">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16.5 16.5 21 21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          <input id="graph-search" placeholder="Поиск типа… ( / )" autocomplete="off" />
        </div>
        <label class="toggle"><input type="checkbox" id="graph-leaves" /> служебные типы (input/enum/scalar)</label>
        <label class="toggle"><input type="checkbox" id="graph-uncovered" /> только непокрытые</label>
        <div class="spacer grow"></div>
        <span class="muted small" id="graph-count"></span>
        <button class="btn small ghost" id="graph-zoom-out" title="Уменьшить">−</button>
        <button class="btn small ghost" id="graph-zoom-in" title="Увеличить">+</button>
        <button class="btn small" id="graph-fit">Вписать</button>
      </div>
      <div class="graph-stage">
        <div class="graph-canvas-wrap">
          <canvas id="graph-canvas" aria-label="Граф схемы GraphQL"></canvas>
          <div class="graph-overlay">
            <span class="legend-row"><span class="legend-swatch covered"></span>покрыто</span>
            <span class="legend-row"><span class="legend-swatch partial"></span>частично</span>
            <span class="legend-row"><span class="legend-swatch uncovered"></span>нет</span>
          </div>
        </div>
        <aside class="graph-panel" id="graph-panel"></aside>
      </div>
    </div>`;

  const panel = node.querySelector('#graph-panel');
  const count = node.querySelector('#graph-count');
  const canvas = new SchemaGraphCanvas(node.querySelector('#graph-canvas'), {
    onSelect: (selected) => renderPanel(selected?.id || null),
    onHover: (hovered, event) => {
      if (!hovered) {
        hideTooltip();
        return;
      }
      showTooltip(
        event,
        `<div class="tt-title">${esc(hovered.id)}</div>
         <div class="tt-sub">${esc(nodeKindLabel(hovered.kind))} · ${pct(hovered.percent)} · ${num(hovered.fieldsCount)} полей · ${num(hovered.hits)} обращений</div>`,
      );
    },
  });

  const renderPanel = (name) => {
    if (!name) {
      panel.innerHTML = `
        <div class="panel-section">
          <div class="panel-label">Как читать граф</div>
          <p class="muted small">Узел — тип схемы. Цвет — доля покрытых полей. Стрелка — поле, возвращающее другой тип; зелёные связи уже использовались в тестах.</p>
        </div>
        <div class="panel-section">
          <div class="panel-label">В срезе</div>
          <div class="row" style="justify-content:space-between"><span class="muted">Типов в схеме</span><strong>${num(coverage.types.length)}</strong></div>
          <div class="row" style="justify-content:space-between"><span class="muted">Связей полей</span><strong>${num((schema.edges || []).length)}</strong></div>
          <div class="row" style="justify-content:space-between"><span class="muted">Покрыто полей</span><strong>${pct(coverage.summary.fieldsPercent)}</strong></div>
          <div class="row" style="justify-content:space-between"><span class="muted">Прогонов</span><strong>${num(coverage.runs.length)}</strong></div>
        </div>
        <div class="panel-section">
          <div class="panel-label">Управление</div>
          <p class="muted small">Колесо — зум, перетаскивание фона — панорама, двойной клик — вписать граф. Клик по узлу показывает поля и связи. Пунктир — аргумент, ведущий к input/enum-типу.</p>
          <p class="muted small">Нажмите <span class="mono">/</span>, чтобы перейти к поиску.</p>
        </div>`;
      return;
    }

    const type = coverage.types.find((item) => item.name === name);
    if (!type) return;
    const fields = [...(type.fields || [])].sort((a, b) => Number(a.covered) - Number(b.covered) || a.name.localeCompare(b.name));
    const tests = Object.keys(type.tests || {});

    panel.innerHTML = `
      <div>
        <div class="row wrap">
          <span class="type-name">${esc(type.name)}</span>
          <span class="pill kind ${esc(type.kind)}">${esc(String(type.kind).replace('INPUT_OBJECT', 'INPUT'))}</span>
        </div>
        ${type.description ? `<div class="type-desc">${esc(type.description)}</div>` : ''}
      </div>
      <div class="panel-section">
        <div class="row" style="justify-content:space-between"><span class="muted">Покрытие</span><strong>${pct(type.percent)}</strong></div>
        ${bar(type.percent)}
        <div class="row" style="justify-content:space-between"><span class="muted small">Полей покрыто</span><span class="small">${num(type.fieldsCovered)} / ${num(type.fieldsCount)}</span></div>
        <div class="row" style="justify-content:space-between"><span class="muted small">Обращений</span><span class="small">${num(type.hits)}</span></div>
        <div class="row" style="justify-content:space-between"><span class="muted small">Тестов</span><span class="small">${num(tests.length)}</span></div>
      </div>
      <div class="panel-section">
        <div class="panel-label">Поля</div>
        ${
          fields.length
            ? fields
                .slice(0, 40)
                .map(
                  (field) => `<div class="field-line ${field.covered ? 'covered' : 'uncovered'}" title="${esc(field.type)}">
                    <span class="name">${esc(field.name)}</span>
                    <span class="hits">${field.covered ? num(field.hits) : '—'}</span>
                  </div>`,
                )
                .join('')
            : '<div class="muted small">Нет полей.</div>'
        }
        ${fields.length > 40 ? `<div class="muted small">…ещё ${fields.length - 40}</div>` : ''}
      </div>
      <div class="row">
        <a class="btn small" href="${href('type', { name })}">Открыть тип</a>
        <a class="btn small ghost" href="${href('fields', { type: name })}">Только поля</a>
      </div>`;
  };

  const updateCount = () => {
    const visible = canvas.visibleNodes().length;
    count.textContent = `${visible} / ${coverage.types.length} типов`;
  };

  node.querySelector('#graph-search').addEventListener(
    'input',
    debounce((event) => {
      canvas.setOptions({ search: event.target.value });
      updateCount();
    }, 160),
  );
  node.querySelector('#graph-leaves').addEventListener('change', (event) => {
    canvas.setOptions({ showLeaves: event.target.checked });
    updateCount();
  });
  node.querySelector('#graph-uncovered').addEventListener('change', (event) => {
    canvas.setOptions({ onlyUncovered: event.target.checked });
    updateCount();
  });
  node.querySelector('#graph-fit').addEventListener('click', () => canvas.fit());
  node.querySelector('#graph-zoom-in').addEventListener('click', () => canvas.zoomAt(canvas.width / 2, canvas.height / 2, 1.2));
  node.querySelector('#graph-zoom-out').addEventListener('click', () => canvas.zoomAt(canvas.width / 2, canvas.height / 2, 1 / 1.2));

  canvas.setData({ nodes, edges });
  renderPanel(null);
  updateCount();

  return {
    node,
    cleanup: () => {
      hideTooltip();
      canvas.destroy();
    },
  };
}
