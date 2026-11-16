/* DOM-хелперы, форматирование и мелкие компоненты. */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** @param {unknown} value */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/** @param {number} value */
export function pct(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0%';
  const rounded = Math.round(number * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

/** @param {number} value */
export function num(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return number.toLocaleString('ru-RU');
}

/** @param {string} iso */
export function fmtDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** @param {string} iso */
export function fmtDay(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
}

/** @param {string} iso */
export function timeAgo(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Math.max(0, Date.now() - then);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} дн назад`;
  return fmtDay(iso);
}

/** @param {number} ms */
export function fmtDuration(ms) {
  const value = Number(ms) || 0;
  if (value < 1000) return `${value} мс`;
  return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} с`;
}

export function kindPill(kind) {
  const label = String(kind || '').replace('INPUT_OBJECT', 'INPUT');
  return `<span class="pill kind ${esc(kind)}">${esc(label)}</span>`;
}

export function statusBadge(status, label) {
  const text = label || { covered: 'покрыт', partial: 'частично', uncovered: 'не покрыт', empty: 'пусто', running: 'идёт', finished: 'завершён', failed: 'ошибка' }[status] || status;
  return `<span class="status ${esc(status)}">${esc(text)}</span>`;
}

/** @param {number} value @param {{ slim?: boolean, amberAt?: number }} [options] */
export function bar(value, options = {}) {
  const percent = Math.max(0, Math.min(100, Number(value) || 0));
  const amberAt = options.amberAt ?? 40;
  const cls = percent >= 80 ? '' : percent >= amberAt ? 'amber' : 'red';
  return `<div class="bar ${cls}${options.slim ? ' slim' : ''}" role="progressbar" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"><span style="width:${Math.max(1.5, percent)}%"></span></div>`;
}

/** @param {number} value @param {number} [size] */
export function ring(value, size = 148) {
  const percent = Math.max(0, Math.min(100, Number(value) || 0));
  const stroke = 11;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dash = (percent / 100) * circumference;
  const color = percent >= 80 ? '#22c55e' : percent >= 40 ? '#f59e0b' : '#ef4444';
  return `<div class="ring" style="width:${size}px;height:${size}px">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
      <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="rgba(148,163,184,.15)" stroke-width="${stroke}"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="${color}" stroke-width="${stroke}"
        stroke-linecap="round" stroke-dasharray="${dash} ${circumference}" style="filter:drop-shadow(0 0 8px ${color}55)"/>
    </svg>
    <div class="ring-center">
      <div class="ring-value">${pct(percent)}</div>
      <div class="ring-caption">покрытие</div>
    </div>
  </div>`;
}

export function pageHead(title, subtitle, actionsHtml = '') {
  return `<div class="page-head">
    <div>
      <h2 class="page-title">${title}</h2>
      ${subtitle ? `<p class="page-sub">${subtitle}</p>` : ''}
    </div>
    ${actionsHtml ? `<div class="page-actions">${actionsHtml}</div>` : ''}
  </div>`;
}

export function emptyState(title, text, actions = '') {
  return `<div class="empty"><strong>${esc(title)}</strong>${text ? `<div>${text}</div>` : ''}${actions ? `<div class="mt-16">${actions}</div>` : ''}</div>`;
}

/** @param {string} message @param {'info'|'error'|'success'} [type] */
export function toast(message, type = 'info') {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  root.append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .25s';
    setTimeout(() => node.remove(), 260);
  }, type === 'error' ? 6000 : 3500);
}

/**
 * Модальное окно.
 * @param {{ title: string, subtitle?: string, body: string|HTMLElement, footer?: string, width?: number, onClose?: () => void }} options
 */
export function openModal({ title, subtitle = '', body, footer = '', width = 820, onClose }) {
  const root = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal" style="width:min(${width}px,100%)" role="dialog" aria-modal="true">
      <div class="modal-head">
        <div>
          <h3 class="modal-title">${title}</h3>
          ${subtitle ? `<div class="modal-sub">${subtitle}</div>` : ''}
        </div>
        <button class="icon-btn" data-close aria-label="Закрыть">✕</button>
      </div>
      <div class="modal-body"></div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    </div>`;

  const bodyHost = backdrop.querySelector('.modal-body');
  if (typeof body === 'string') bodyHost.innerHTML = body;
  else bodyHost.append(body);

  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });
  backdrop.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', close));
  document.addEventListener('keydown', onKey);
  root.append(backdrop);
  return { close, element: backdrop };
}

let tooltipNode = null;

/** @param {MouseEvent} event @param {string} html */
export function showTooltip(event, html) {
  if (!tooltipNode) tooltipNode = document.getElementById('tooltip');
  if (!tooltipNode) return;
  tooltipNode.innerHTML = html;
  tooltipNode.hidden = false;
  const padding = 14;
  const rect = tooltipNode.getBoundingClientRect();
  let x = event.clientX + padding;
  let y = event.clientY + padding;
  if (x + rect.width > window.innerWidth - 8) x = event.clientX - rect.width - padding;
  if (y + rect.height > window.innerHeight - 8) y = event.clientY - rect.height - padding;
  tooltipNode.style.left = `${Math.max(8, x)}px`;
  tooltipNode.style.top = `${Math.max(8, y)}px`;
}

export function hideTooltip() {
  if (!tooltipNode) tooltipNode = document.getElementById('tooltip');
  if (tooltipNode) tooltipNode.hidden = true;
}

/** @template {Function} T @param {T} fn @param {number} wait */
export function debounce(fn, wait = 180) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/** @param {string} query @param {Record<string, string>} params */
export function withQuery(query, params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) if (value) search.set(key, value);
  const suffix = search.toString();
  return suffix ? `${query}?${suffix}` : query;
}
