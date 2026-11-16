/* Интерактивный граф схемы на canvas: force-layout, зум, панорама, подсветка связей. */

const STATUS_COLORS = {
  covered: '#22c55e',
  partial: '#f59e0b',
  uncovered: '#ef4444',
  empty: '#64748b',
};

const LEAF_KINDS = new Set(['SCALAR', 'ENUM', 'INPUT_OBJECT']);
const TYPE_GLYPH = {
  OBJECT: 'type',
  INTERFACE: 'interface',
  UNION: 'union',
  INPUT_OBJECT: 'input',
  ENUM: 'enum',
  SCALAR: 'scalar',
};

export class SchemaGraphCanvas {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ onSelect?: (node: any) => void, onHover?: (node: any|null, event: any) => void }} [handlers]
   */
  constructor(canvas, { onSelect, onHover } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSelect = onSelect;
    this.onHover = onHover;

    this.nodes = [];
    this.edges = [];
    this.nodeById = new Map();
    this.adjacency = new Map();

    this.view = { x: 0, y: 0, k: 1 };
    this.options = { showLeaves: false, onlyUncovered: false, search: '', showLabels: true };
    this.selectedId = null;
    this.hoveredId = null;

    this.mode = 'idle';
    this.dragNode = null;
    this.dragMoved = false;
    this.lastPointer = { x: 0, y: 0 };
    this.needsFit = true;
    this.destroyed = false;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);

    this.abort = new AbortController();
    this.bindEvents();
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas.parentElement || canvas);
    this.resize();
  }

  bindEvents() {
    const signal = this.abort.signal;
    const canvas = this.canvas;

    canvas.addEventListener('pointerdown', (event) => this.handlePointerDown(event), { signal });
    canvas.addEventListener('pointermove', (event) => this.handlePointerMove(event), { signal });
    canvas.addEventListener('pointerup', (event) => this.handlePointerUp(event), { signal });
    canvas.addEventListener('pointercancel', () => this.handlePointerUp({}), { signal });
    canvas.addEventListener('pointerleave', () => {
      this.hoveredId = null;
      this.onHover?.(null);
      this.draw();
    }, { signal });
    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const mx = event.clientX - rect.left;
        const my = event.clientY - rect.top;
        const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
        this.zoomAt(mx, my, factor);
      },
      { signal, passive: false },
    );
    canvas.addEventListener('dblclick', () => this.fit(), { signal });
  }

  resize() {
    if (this.destroyed) return;
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const width = Math.max(160, parent.clientWidth);
    const height = Math.max(160, parent.clientHeight);
    this.width = width;
    this.height = height;
    this.canvas.width = Math.floor(width * this.dpr);
    this.canvas.height = Math.floor(height * this.dpr);
    if (this.needsFit && this.nodes.length > 0) {
      this.needsFit = false;
      this.fit();
    } else {
      this.draw();
    }
  }

  /**
   * @param {{ nodes: any[], edges: any[] }} data
   */
  setData({ nodes, edges }) {
    const degree = new Map();
    for (const edge of edges) {
      degree.set(edge.source, (degree.get(edge.source) || 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) || 0) + 1);
    }

    this.nodes = (nodes || []).map((node, index) => ({
      ...node,
      radius: this.radiusFor(node),
      degree: degree.get(node.id) || 0,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      index,
    }));
    this.edges = (edges || []).map((edge) => ({ ...edge }));
    this.nodeById = new Map(this.nodes.map((node) => [node.id, node]));
    this.adjacency = new Map();
    for (const edge of this.edges) {
      if (!this.adjacency.has(edge.source)) this.adjacency.set(edge.source, []);
      if (!this.adjacency.has(edge.target)) this.adjacency.set(edge.target, []);
      this.adjacency.get(edge.source).push({ edge, other: edge.target });
      this.adjacency.get(edge.target).push({ edge, other: edge.source });
    }

    this.seedPositions();
    this.simulate();
    this.relaxCollisions();
    this.needsFit = true;
    this.fit();
  }

  radiusFor(node) {
    if (LEAF_KINDS.has(node.kind)) return 7;
    const fields = Number(node.fieldsCount) || 0;
    return 11 + Math.min(15, Math.sqrt(fields + 1) * 3.1);
  }

  seedPositions() {
    const golden = Math.PI * (3 - Math.sqrt(5));
    const count = this.nodes.length || 1;
    const sorted = [...this.nodes].sort((a, b) => b.degree - a.degree);
    const order = new Map(sorted.map((node, index) => [node.id, index]));
    for (const node of this.nodes) {
      const index = order.get(node.id) ?? 0;
      const ring = 90 + Math.sqrt(index + 1) * (34 + Math.sqrt(count) * 2.4);
      const angle = index * golden;
      node.x = Math.cos(angle) * ring;
      node.y = Math.sin(angle) * ring;
      node.vx = 0;
      node.vy = 0;
    }
  }

  simulate() {
    const nodes = this.nodes;
    const count = nodes.length;
    if (count === 0) return;
    const iterations = Math.max(120, Math.min(420, Math.round(120000 / count)));
    const repulsion = 6200;
    const linkDistance = 158;
    const linkStrength = 0.05;
    const gravity = 0.014;
    const damping = 0.72;
    let alpha = 1;

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      for (let i = 0; i < count; i += 1) {
        const a = nodes[i];
        for (let j = i + 1; j < count; j += 1) {
          const b = nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let distanceSq = dx * dx + dy * dy;
          if (distanceSq < 0.01) {
            dx = (Math.random() - 0.5) * 2;
            dy = (Math.random() - 0.5) * 2;
            distanceSq = dx * dx + dy * dy;
          }
          const distance = Math.sqrt(distanceSq);
          const force = (repulsion / Math.max(distanceSq, 60)) * alpha;
          const fx = (dx / distance) * force;
          const fy = (dy / distance) * force;
          a.vx += fx;
          a.vy += fy;
          b.vx -= fx;
          b.vy -= fy;
        }
      }

      for (const edge of this.edges) {
        const a = this.nodeById.get(edge.source);
        const b = this.nodeById.get(edge.target);
        if (!a || !b || a === b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.hypot(dx, dy) || 1;
        const force = (distance - linkDistance) * linkStrength * alpha;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }

      for (const node of nodes) {
        node.vx -= node.x * gravity * alpha;
        node.vy -= node.y * gravity * alpha;
        node.vx *= damping;
        node.vy *= damping;
        const speed = Math.hypot(node.vx, node.vy);
        if (speed > 26) {
          node.vx = (node.vx / speed) * 26;
          node.vy = (node.vy / speed) * 26;
        }
        node.x += node.vx;
        node.y += node.vy;
      }

      alpha *= 0.975;
      if (alpha < 0.02) break;
    }
  }

  relaxCollisions() {
    for (let pass = 0; pass < 12; pass += 1) {
      let moved = false;
      for (let i = 0; i < this.nodes.length; i += 1) {
        const a = this.nodes[i];
        for (let j = i + 1; j < this.nodes.length; j += 1) {
          const b = this.nodes[j];
          const minDistance = a.radius + b.radius + 34;
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let distance = Math.hypot(dx, dy);
          if (distance >= minDistance) continue;
          moved = true;
          if (distance < 0.01) {
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            distance = 0.5;
          }
          const push = (minDistance - distance) / 2;
          const ux = dx / distance;
          const uy = dy / distance;
          a.x -= ux * push;
          a.y -= uy * push;
          b.x += ux * push;
          b.y += uy * push;
        }
      }
      if (!moved) break;
    }
  }

  isVisible(node) {
    if (!node) return false;
    if (LEAF_KINDS.has(node.kind) && !this.options.showLeaves) return false;
    if (this.options.onlyUncovered && node.status === 'covered') return false;
    return true;
  }

  matchesSearch(node) {
    const query = this.options.search.trim().toLowerCase();
    if (!query) return false;
    return node.id.toLowerCase().includes(query);
  }

  visibleNodes() {
    return this.nodes.filter((node) => this.isVisible(node));
  }

  edgesForVisible() {
    return this.edges.filter((edge) => {
      const a = this.nodeById.get(edge.source);
      const b = this.nodeById.get(edge.target);
      return this.isVisible(a) && this.isVisible(b);
    });
  }

  screenToWorld(x, y) {
    return { x: (x - this.view.x) / this.view.k, y: (y - this.view.y) / this.view.k };
  }

  worldToScreen(x, y) {
    return { x: x * this.view.k + this.view.x, y: y * this.view.k + this.view.y };
  }

  zoomAt(mx, my, factor) {
    const world = this.screenToWorld(mx, my);
    const next = Math.min(3.2, Math.max(0.22, this.view.k * factor));
    this.view.k = next;
    this.view.x = mx - world.x * next;
    this.view.y = my - world.y * next;
    this.draw();
  }

  fit() {
    const nodes = this.visibleNodes();
    if (nodes.length === 0) {
      this.view = { x: this.width / 2, y: this.height / 2, k: 1 };
      this.draw();
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of nodes) {
      minX = Math.min(minX, node.x - node.radius - 40);
      minY = Math.min(minY, node.y - node.radius - 26);
      maxX = Math.max(maxX, node.x + node.radius + 40);
      maxY = Math.max(maxY, node.y + node.radius + 34);
    }
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const scale = Math.min(this.width / spanX, this.height / spanY) * 0.9;
    const k = Math.min(1.6, Math.max(0.22, scale));
    this.view.k = k;
    this.view.x = this.width / 2 - ((minX + maxX) / 2) * k;
    this.view.y = this.height / 2 - ((minY + maxY) / 2) * k;
    this.draw();
  }

  focusNode(id) {
    const node = this.nodeById.get(id);
    if (!node) return;
    const k = Math.max(1, Math.min(1.8, this.view.k));
    this.view.k = k;
    this.view.x = this.width / 2 - node.x * k;
    this.view.y = this.height / 2 - node.y * k;
    this.draw();
  }

  select(id) {
    this.selectedId = id;
    this.draw();
    this.onSelect?.(id ? this.nodeById.get(id) || null : null);
  }

  setOptions(patch = {}) {
    const previousLeaves = this.options.showLeaves;
    const previousOnlyUncovered = this.options.onlyUncovered;
    Object.assign(this.options, patch);
    const structural = previousLeaves !== this.options.showLeaves || previousOnlyUncovered !== this.options.onlyUncovered;
    if (structural && this.nodes.length > 0) this.fit();
    else this.draw();
  }

  hitTest(x, y) {
    const world = this.screenToWorld(x, y);
    const nodes = this.visibleNodes();
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index];
      const distance = Math.hypot(world.x - node.x, world.y - node.y);
      if (distance <= node.radius + 6) return node;
    }
    return null;
  }

  handlePointerDown(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    this.lastPointer = { x, y };
    this.dragMoved = false;
    const node = this.hitTest(x, y);
    if (node) {
      this.mode = 'drag';
      this.dragNode = node;
      this.canvas.setPointerCapture?.(event.pointerId);
    } else {
      this.mode = 'pan';
      this.canvas.setPointerCapture?.(event.pointerId);
    }
  }

  handlePointerMove(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    if (this.mode === 'pan') {
      const dx = x - this.lastPointer.x;
      const dy = y - this.lastPointer.y;
      this.view.x += dx;
      this.view.y += dy;
      this.lastPointer = { x, y };
      this.dragMoved = true;
      this.draw();
      return;
    }

    if (this.mode === 'drag' && this.dragNode) {
      const world = this.screenToWorld(x, y);
      this.dragNode.x = world.x;
      this.dragNode.y = world.y;
      this.lastPointer = { x, y };
      this.dragMoved = true;
      this.draw();
      return;
    }

    const node = this.hitTest(x, y);
    const nextId = node?.id || null;
    if (nextId !== this.hoveredId) {
      this.hoveredId = nextId;
      this.canvas.style.cursor = node ? 'pointer' : 'grab';
      this.draw();
    }
    this.onHover?.(node, event);
  }

  handlePointerUp() {
    if (this.mode === 'drag' && this.dragNode && !this.dragMoved) {
      this.select(this.dragNode.id);
    } else if (this.mode === 'pan' && !this.dragMoved) {
      this.select(null);
    }
    this.mode = 'idle';
    this.dragNode = null;
    this.canvas.style.cursor = 'grab';
  }

  draw() {
    if (this.destroyed) return;
    const { ctx } = this;
    const width = this.width || 1;
    const height = this.height || 1;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(this.view.x, this.view.y);
    ctx.scale(this.view.k, this.view.k);

    const visible = new Set(this.visibleNodes().map((node) => node.id));
    const hovered = this.hoveredId ? this.nodeById.get(this.hoveredId) : null;
    const selected = this.selectedId ? this.nodeById.get(this.selectedId) : null;
    const focusNode = hovered || selected;
    const search = this.options.search.trim().toLowerCase();
    const edgeList = this.edges.filter((edge) => visible.has(edge.source) && visible.has(edge.target));

    const pairOffset = new Map();
    for (const edge of edgeList) {
      const key = `${edge.source}->${edge.target}`;
      pairOffset.set(key, (pairOffset.get(key) || 0) + 1);
    }

    for (const edge of edgeList) {
      const a = this.nodeById.get(edge.source);
      const b = this.nodeById.get(edge.target);
      if (!a || !b) continue;
      const isFocus = focusNode && (focusNode.id === a.id || focusNode.id === b.id);
      const isDimmed = search && !(this.matchesSearch(a) || this.matchesSearch(b));
      if (isDimmed && !isFocus) continue;

      const reverse = pairOffset.has(`${edge.target}->${edge.source}`);
      const offset = reverse ? 18 : 0;
      ctx.beginPath();
      ctx.strokeStyle = isFocus
        ? 'rgba(167, 139, 250, 0.85)'
        : edge.arg
          ? 'rgba(148, 163, 184, 0.12)'
          : edge.covered
            ? 'rgba(34, 197, 94, 0.30)'
            : 'rgba(148, 163, 184, 0.16)';
      ctx.lineWidth = isFocus ? 2 : edge.arg ? 1 : 1.1;
      ctx.setLineDash(edge.arg ? [4, 5] : []);
      this.curveBetween(ctx, a, b, offset);
      ctx.stroke();
      ctx.setLineDash([]);

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy) || 1;
      const ux = dx / distance;
      const uy = dy / distance;
      const tipX = b.x - ux * (b.radius + 2);
      const tipY = b.y - uy * (b.radius + 2);
      const size = isFocus ? 7 : 5;
      ctx.beginPath();
      ctx.fillStyle = isFocus ? 'rgba(167, 139, 250, 0.95)' : edge.covered ? 'rgba(34, 197, 94, 0.45)' : 'rgba(148, 163, 184, 0.25)';
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - ux * size - uy * size * 0.5, tipY - uy * size + ux * size * 0.5);
      ctx.lineTo(tipX - ux * size + uy * size * 0.5, tipY - uy * size - ux * size * 0.5);
      ctx.closePath();
      ctx.fill();

      if (isFocus && this.view.k > 0.5) {
        const label = edge.field;
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        ctx.font = '500 10px Inter, system-ui, sans-serif';
        const textWidth = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(7, 12, 22, 0.85)';
        ctx.fillRect(midX - textWidth / 2 - 4, midY - 8, textWidth + 8, 15);
        ctx.fillStyle = 'rgba(196, 181, 253, 0.95)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, midX, midY);
      }
    }

    const labelAll = this.options.showLabels && (this.nodes.length <= 70 || this.view.k > 0.85);
    for (const node of this.visibleNodes()) {
      const isHovered = hovered?.id === node.id;
      const isSelected = selected?.id === node.id;
      const matched = search ? this.matchesSearch(node) : false;
      const dimmed = Boolean(search) && !matched && !isHovered && !isSelected;
      const color = STATUS_COLORS[node.status] || STATUS_COLORS.empty;

      ctx.globalAlpha = dimmed ? 0.18 : 1;
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius + (isHovered ? 2 : 0), 0, Math.PI * 2);
      ctx.fillStyle = this.withAlpha(color, node.status === 'uncovered' ? 0.16 : 0.22);
      ctx.fill();
      ctx.lineWidth = isSelected || isHovered ? 2.6 : 1.6;
      ctx.strokeStyle = color;
      ctx.stroke();

      if (node.isRoot) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius + 5, 0, Math.PI * 2);
        ctx.strokeStyle = this.withAlpha('#a78bfa', 0.6);
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }

      if (matched) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius + 9, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(34, 211, 238, 0.85)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      if (isSelected) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius + 7, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }

      const showLabel = labelAll || isHovered || isSelected || matched || node.isRoot;
      if (showLabel) {
        const label = node.id;
        ctx.font = `${isHovered || isSelected ? '600' : '500'} 11.5px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const textWidth = ctx.measureText(label).width;
        const inside = textWidth < node.radius * 1.75 && node.radius > 17;
        const x = inside ? node.x : node.x;
        const y = inside ? node.y : node.y + node.radius + 11;
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = 'rgba(6, 10, 18, 0.92)';
        ctx.strokeText(label, x, y);
        ctx.fillStyle = dimmed ? 'rgba(148,163,184,0.5)' : '#dbe6f5';
        ctx.fillText(label, x, y);
      }
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }

  curveBetween(ctx, a, b, offset) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const distance = Math.hypot(dx, dy) || 1;
    const nx = -dy / distance;
    const ny = dx / distance;
    const startX = a.x + (dx / distance) * a.radius;
    const startY = a.y + (dy / distance) * a.radius;
    const endX = b.x - (dx / distance) * (b.radius + 2);
    const endY = b.y - (dy / distance) * (b.radius + 2);
    const midX = (startX + endX) / 2 + nx * offset;
    const midY = (startY + endY) / 2 + ny * offset;
    ctx.moveTo(startX, startY);
    ctx.quadraticCurveTo(midX, midY, endX, endY);
  }

  withAlpha(hex, alpha) {
    const value = hex.replace('#', '');
    const r = Number.parseInt(value.slice(0, 2), 16);
    const g = Number.parseInt(value.slice(2, 4), 16);
    const b = Number.parseInt(value.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  destroy() {
    this.destroyed = true;
    this.abort.abort();
    this.observer.disconnect();
  }
}

export function nodeKindLabel(kind) {
  return TYPE_GLYPH[kind] || String(kind).toLowerCase();
}
