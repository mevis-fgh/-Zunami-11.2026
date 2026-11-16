import path from 'node:path';
import { JsonStore } from './json-store.js';
import { isSafeId, nowIso, shortHash, slugify } from '../utils/id.js';
import { badRequest, notFound } from '../utils/errors.js';
import { applyAnalysisToCoverage, blankCoverage, computeCoverageStats, mergeCoverage } from '../coverage/stats.js';

const RUN_META_FIELDS = ['name', 'branch', 'team', 'env', 'build', 'commit', 'notes'];
const RUN_STATUSES = new Set(['running', 'finished', 'failed', 'aborted']);

/**
 * Приводит границу периода к ISO: дата без времени расширяется до начала/конца дня.
 * @param {string} value
 * @param {boolean} endOfDay
 */
function normalizeBoundary(value, endOfDay) {
  const raw = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`;
  return raw;
}

/**
 * Репозиторий поверх JSON-хранилища:
 * схемы-снапшоты, прогоны, журнал исполнений, агрегаты покрытия.
 */
export class Repository {
  /**
   * @param {{ config: any, logger: any, store?: JsonStore }} options
   */
  constructor({ config, logger, store }) {
    this.config = config;
    this.logger = logger;
    this.store = store || new JsonStore({ dir: path.join(config.dataDir), logger });
    /** @type {Map<string, any>} */
    this.schemas = new Map();
    /** @type {Map<string, any>} */
    this.runs = new Map();
    /** @type {Map<string, any>} */
    this.coverage = new Map();
    /** @type {Map<string, any>} */
    this.executionCache = new Map();
    /** @type {Map<string, Promise<unknown>>} */
    this.locks = new Map();
    this.activeSchemaId = '';
  }

  async init() {
    for (const dir of ['schemas', 'runs', 'coverage', 'executions']) await this.store.mkdir(dir);

    for (const file of (await this.store.listDir('schemas')).filter((name) => name.endsWith('.json'))) {
      const snapshot = await this.store.read(`schemas/${file}`, null);
      if (snapshot?.id) this.schemas.set(snapshot.id, snapshot);
    }

    const active = await this.store.read('schema-active.json', null);
    if (active?.schemaId && this.schemas.has(active.schemaId)) this.activeSchemaId = active.schemaId;
    else this.activeSchemaId = [...this.schemas.keys()].pop() || '';

    for (const file of (await this.store.listDir('runs')).filter((name) => name.endsWith('.json'))) {
      const run = await this.store.read(`runs/${file}`, null);
      if (run?.runId) this.runs.set(run.runId, run);
    }

    this.logger?.info?.('repository.ready', {
      schemas: this.schemas.size,
      runs: this.runs.size,
      activeSchemaId: this.activeSchemaId,
    });
    return this;
  }

  // -------------------------------------------------------------------------
  // Схемы
  // -------------------------------------------------------------------------

  /**
   * @param {{ sdl: string, graph: any, source: string, endpoint?: string, service?: string, name?: string }} input
   */
  async saveSchema({ sdl, graph, source, endpoint = '', service = 'default', name = '' }) {
    if (typeof sdl !== 'string' || !sdl.trim()) throw badRequest('SDL не может быть пустым');
    const id = `sch_${shortHash(`${service}:${sdl}`, 12)}`;
    const existing = this.schemas.get(id);
    if (existing) {
      await this.activateSchema(id);
      return existing;
    }
    const snapshot = {
      id,
      name: name || `${service} · ${new Date().toISOString().slice(0, 10)}`,
      service,
      source,
      endpoint,
      createdAt: nowIso(),
      sdl,
      graph,
      stats: graph.stats,
    };
    await this.store.write(`schemas/${id}.json`, snapshot);
    this.schemas.set(id, snapshot);
    await this.activateSchema(id);
    this.logger?.info?.('schema.saved', {
      id,
      service,
      source,
      types: graph.stats.types,
      fields: graph.stats.fields,
    });
    return snapshot;
  }

  /** @returns {any[]} */
  listSchemas() {
    return [...this.schemas.values()]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((snapshot) => ({
        id: snapshot.id,
        name: snapshot.name,
        service: snapshot.service,
        source: snapshot.source,
        endpoint: snapshot.endpoint,
        createdAt: snapshot.createdAt,
        stats: snapshot.stats,
        active: snapshot.id === this.activeSchemaId,
      }));
  }

  /** @param {string} id */
  getSchema(id) {
    return this.schemas.get(id) || null;
  }

  getActiveSchema() {
    return this.activeSchemaId ? this.schemas.get(this.activeSchemaId) || null : null;
  }

  /** @param {string} id */
  async activateSchema(id) {
    const snapshot = this.schemas.get(id);
    if (!snapshot) throw notFound(`Схема ${id} не найдена`);
    this.activeSchemaId = id;
    await this.store.write('schema-active.json', { schemaId: id, updatedAt: nowIso() });
    return snapshot;
  }

  /** @param {string} id */
  async deleteSchema(id) {
    if (!this.schemas.has(id)) throw notFound(`Схема ${id} не найдена`);
    this.schemas.delete(id);
    await this.store.remove(`schemas/${id}.json`);
    if (this.activeSchemaId === id) {
      this.activeSchemaId = [...this.schemas.keys()].pop() || '';
      await this.store.write('schema-active.json', { schemaId: this.activeSchemaId, updatedAt: nowIso() });
    }
    return { deleted: id, activeSchemaId: this.activeSchemaId };
  }

  // -------------------------------------------------------------------------
  // Прогоны
  // -------------------------------------------------------------------------

  /**
   * Если тест не передал x-run-id — собираем детерминированный авто-прогон.
   * @param {{ runId?: string, branch?: string, env?: string, service?: string }} input
   */
  resolveRunId(input = {}) {
    if (input.runId) {
      if (!isSafeId(input.runId)) {
        throw badRequest('Некорректный run id: допустимы A-Z a-z 0-9 . _ : - (до 120 символов)');
      }
      return input.runId;
    }
    const mode = this.config.autoRunMode || 'daily';
    if (mode === 'off') return 'adhoc';
    const parts = [
      input.env || this.config.defaultEnv || 'local',
      slugify(input.branch || 'no-branch', 40) || 'no-branch',
      slugify(input.service || 'default', 30) || 'default',
    ];
    if (mode === 'daily') parts.push(new Date().toISOString().slice(0, 10));
    parts.unshift('auto');
    return parts.join('-').slice(0, 120);
  }

  /**
   * Находит или создаёт прогон.
   * @param {{ runId?: string, name?: string, branch?: string, team?: string, env?: string, build?: string, commit?: string, service?: string, source?: string }} input
   */
  async ensureRun(input = {}) {
    const runId = this.resolveRunId(input);
    let run = this.runs.get(runId);
    if (!run) {
      run = {
        runId,
        name: input.name || runId,
        service: input.service || 'default',
        branch: input.branch || '',
        team: input.team || '',
        env: input.env || this.config.defaultEnv || '',
        build: input.build || '',
        commit: input.commit || '',
        notes: '',
        status: 'running',
        source: input.source || 'proxy',
        schemaId: this.activeSchemaId || '',
        createdAt: nowIso(),
        startedAt: nowIso(),
        lastSeenAt: nowIso(),
        finishedAt: null,
        requests: 0,
        fieldsCovered: 0,
        fieldsTotal: 0,
        percent: 0,
      };
      this.runs.set(runId, run);
      await this.#persistRun(run);
      this.logger?.info?.('run.created', { runId, branch: run.branch, env: run.env, service: run.service });
    } else {
      let dirty = false;
      for (const field of RUN_META_FIELDS) {
        if (!run[field] && input[field]) {
          run[field] = input[field];
          dirty = true;
        }
      }
      if (!run.schemaId && this.activeSchemaId) {
        run.schemaId = this.activeSchemaId;
        dirty = true;
      }
      if (dirty) await this.#persistRun(run);
    }
    return run;
  }

  /** @param {string} runId */
  getRun(runId) {
    return this.runs.get(runId) || null;
  }

  /**
   * @param {{ branch?: string, team?: string, env?: string, service?: string, schemaId?: string,
   *           status?: string, from?: string, to?: string, q?: string, limit?: number, offset?: number,
   *           order?: 'asc'|'desc' }} [filters]
   */
  listRuns(filters = {}) {
    const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 500);
    const offset = Math.max(Number(filters.offset) || 0, 0);
    const query = String(filters.q || '').toLowerCase();

    let runs = [...this.runs.values()];
    if (filters.branch) runs = runs.filter((run) => run.branch === filters.branch);
    if (filters.team) runs = runs.filter((run) => run.team === filters.team);
    if (filters.env) runs = runs.filter((run) => run.env === filters.env);
    if (filters.service) runs = runs.filter((run) => run.service === filters.service);
    if (filters.schemaId) runs = runs.filter((run) => run.schemaId === filters.schemaId);
    if (filters.status) runs = runs.filter((run) => run.status === filters.status);
    if (filters.from) {
      const from = normalizeBoundary(filters.from, false);
      runs = runs.filter((run) => String(run.startedAt || '') >= from);
    }
    if (filters.to) {
      const to = normalizeBoundary(filters.to, true);
      runs = runs.filter((run) => String(run.startedAt || '') <= to);
    }
    if (query) {
      runs = runs.filter(
        (run) =>
          run.runId.toLowerCase().includes(query) ||
          String(run.name || '').toLowerCase().includes(query) ||
          String(run.branch || '').toLowerCase().includes(query),
      );
    }

    const order = filters.order === 'asc' ? 1 : -1;
    runs.sort((a, b) => order * String(a.startedAt || '').localeCompare(String(b.startedAt || '')));
    const total = runs.length;
    return { items: runs.slice(offset, offset + limit), total, limit, offset };
  }

  /**
   * @param {string} runId
   * @param {{ status?: string, name?: string, branch?: string, team?: string, env?: string, build?: string, commit?: string, notes?: string }} patch
   */
  async updateRun(runId, patch = {}) {
    const run = this.runs.get(runId);
    if (!run) throw notFound(`Прогон ${runId} не найден`);
    for (const field of RUN_META_FIELDS) {
      if (patch[field] !== undefined) run[field] = String(patch[field] ?? '').slice(0, 200);
    }
    if (patch.status && RUN_STATUSES.has(patch.status)) {
      run.status = patch.status;
      if (patch.status !== 'running') run.finishedAt = nowIso();
    }
    await this.#persistRun(run);
    return run;
  }

  /** @param {string} runId */
  async deleteRun(runId) {
    if (!this.runs.has(runId)) throw notFound(`Прогон ${runId} не найден`);
    this.runs.delete(runId);
    this.coverage.delete(runId);
    await this.store.remove(`runs/${runId}.json`);
    await this.store.remove(`coverage/${runId}.json`);
    return { deleted: runId };
  }

  /** Сохраняет произвольные изменения прогона (используется сидером и тестами). */
  async saveRun(run) {
    if (!run?.runId || !isSafeId(run.runId)) throw badRequest('Некорректный run id');
    this.runs.set(run.runId, run);
    await this.#persistRun(run);
    return run;
  }

  /** @param {any} run */
  async #persistRun(run) {
    await this.store.write(`runs/${run.runId}.json`, run);
  }

  // -------------------------------------------------------------------------
  // Журнал исполнений
  // -------------------------------------------------------------------------

  /** @param {any} record */
  async recordExecution(record) {
    const day = String(record.at || nowIso()).slice(0, 10);
    await this.store.appendLine(`executions/${day}.jsonl`, record);
    this.executionCache.set(record.id, record);
    if (this.executionCache.size > 500) {
      const oldest = this.executionCache.keys().next().value;
      this.executionCache.delete(oldest);
    }
  }

  /**
   * @param {{ runId?: string, service?: string, type?: string, status?: string, test?: string,
   *           q?: string, from?: string, to?: string, limit?: number, offset?: number }} [filters]
   */
  async listExecutions(filters = {}) {
    const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 500);
    const offset = Math.max(Number(filters.offset) || 0, 0);
    const files = await this.#executionFiles(filters.from, filters.to);
    const matches = [];
    let scanned = 0;

    for (const file of files) {
      const records = await this.store.readLines(`executions/${file}`);
      for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index];
        scanned += 1;
        if (this.#matchesExecution(record, filters)) matches.push(record);
        if (matches.length >= offset + limit) break;
      }
      if (matches.length >= offset + limit) break;
    }

    return {
      items: matches.slice(offset, offset + limit).map(compactExecution),
      total: matches.length >= offset + limit ? null : matches.length,
      scanned,
      limit,
      offset,
    };
  }

  /** @param {string} id */
  async getExecution(id) {
    if (this.executionCache.has(id)) return this.executionCache.get(id);
    const files = await this.#executionFiles();
    for (const file of files) {
      const records = await this.store.readLines(`executions/${file}`);
      for (let index = records.length - 1; index >= 0; index -= 1) {
        if (records[index]?.id === id) {
          this.executionCache.set(id, records[index]);
          return records[index];
        }
      }
    }
    return null;
  }

  /** @param {string} [from] @param {string} [to] */
  async #executionFiles(from, to) {
    const names = (await this.store.listDir('executions')).filter((name) => name.endsWith('.jsonl'));
    const lookbackDays = this.config.storage?.executionLookbackDays ?? 14;
    const cutoff =
      from || new Date(Date.now() - lookbackDays * 86400000).toISOString().slice(0, 10);
    return names
      .filter((name) => {
        const day = name.slice(0, 10);
        if (from && day < from) return false;
        if (to && day > to) return false;
        return day >= cutoff;
      })
      .sort()
      .reverse();
  }

  /** @param {any} record @param {any} filters */
  #matchesExecution(record, filters) {
    if (!record) return false;
    if (filters.runId && record.runId !== filters.runId) return false;
    if (filters.service && record.service !== filters.service) return false;
    if (filters.type && record.operationType !== filters.type) return false;
    if (filters.status) {
      const status = Number(record.status) || 0;
      if (filters.status === 'error' && status >= 200 && status < 400) return false;
      if (filters.status === 'ok' && (status < 200 || status >= 400)) return false;
    }
    if (filters.test && record.test?.key !== filters.test && record.test?.name !== filters.test) return false;
    if (filters.q) {
      const query = filters.q.toLowerCase();
      const haystack = `${record.operationName || ''} ${record.query || ''} ${record.test?.name || ''} ${record.runId || ''}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Покрытие
  // -------------------------------------------------------------------------

  /** @param {string} runId */
  async getCoverage(runId) {
    if (this.coverage.has(runId)) return this.coverage.get(runId);
    const stored = await this.store.read(`coverage/${runId}.json`, null);
    if (stored?.runId) this.coverage.set(runId, stored);
    return stored;
  }

  /**
   * Обновляет агрегат покрытия прогона по результату анализа запроса.
   *
   * @param {{ run: any, analysis: any, test?: { key?: string, name?: string },
   *           ok?: boolean, parsed?: boolean, at?: string }} params
   */
  async applyCoverage({ run, analysis, test = {}, ok = true, parsed = true, at = nowIso() }) {
    return this.#withLock(`coverage:${run.runId}`, async () => {
      const stored = await this.getCoverage(run.runId);
      const coverage = stored || blankCoverage(run.runId, run.schemaId || this.activeSchemaId || '');

      if (!coverage.schemaId) coverage.schemaId = run.schemaId || this.activeSchemaId || '';
      if (!run.schemaId && coverage.schemaId) run.schemaId = coverage.schemaId;

      const { newlyCovered } = applyAnalysisToCoverage({ coverage, analysis, at, test, ok, parsed });

      const snapshot = coverage.schemaId ? this.schemas.get(coverage.schemaId) : null;
      const stats = snapshot?.graph ? computeCoverageStats(coverage, snapshot.graph) : coverage.stats || null;
      coverage.stats = stats;

      await this.store.write(`coverage/${run.runId}.json`, coverage);
      this.coverage.set(run.runId, coverage);

      run.requests = coverage.requests;
      run.fieldsCovered = stats?.fieldsCovered || 0;
      run.fieldsTotal = stats?.fieldsTotal || 0;
      run.percent = stats?.fieldsPercent || 0;
      run.lastSeenAt = at;
      if (run.status !== 'finished') run.status = 'running';
      await this.#persistRun(run);

      return { coverage, stats, newlyCovered };
    });
  }

  /**
   * @param {string[]} runIds
   */
  async mergedCoverage(runIds) {
    const coverages = [];
    for (const runId of runIds) {
      const coverage = await this.getCoverage(runId);
      if (coverage) coverages.push(coverage);
    }
    return mergeCoverage(coverages);
  }

  // -------------------------------------------------------------------------
  // Полное состояние (экспорт/импорт для бэкапов и переездов)
  // -------------------------------------------------------------------------

  async exportState() {
    return {
      version: 1,
      exportedAt: nowIso(),
      activeSchemaId: this.activeSchemaId,
      schemas: [...this.schemas.values()],
      runs: [...this.runs.values()],
      coverage: [...this.coverage.values()],
    };
  }

  /**
   * @param {{ schemas?: any[], runs?: any[], coverage?: any[], activeSchemaId?: string }} state
   */
  async importState(state = {}) {
    let schemas = 0;
    let runs = 0;
    let coverage = 0;

    for (const snapshot of state.schemas || []) {
      if (!snapshot?.id || !snapshot.sdl || !snapshot.graph) continue;
      await this.store.write(`schemas/${snapshot.id}.json`, snapshot);
      this.schemas.set(snapshot.id, snapshot);
      schemas += 1;
    }
    for (const run of state.runs || []) {
      if (!run?.runId || !isSafeId(run.runId)) continue;
      await this.store.write(`runs/${run.runId}.json`, run);
      this.runs.set(run.runId, run);
      runs += 1;
    }
    for (const cov of state.coverage || []) {
      if (!cov?.runId || !isSafeId(cov.runId)) continue;
      await this.store.write(`coverage/${cov.runId}.json`, cov);
      this.coverage.set(cov.runId, cov);
      coverage += 1;
    }
    if (state.activeSchemaId && this.schemas.has(state.activeSchemaId)) {
      await this.activateSchema(state.activeSchemaId);
    }
    return { schemas, runs, coverage, activeSchemaId: this.activeSchemaId };
  }

  /** Удаляет старые JSONL-журналы за пределами retention. */
  async prune() {
    const retention = Number(this.config.storage?.retentionDays) || 0;
    if (retention <= 0) return { removed: 0 };
    const cutoff = new Date(Date.now() - retention * 86400000).toISOString().slice(0, 10);
    let removed = 0;
    for (const name of await this.store.listDir('executions')) {
      if (!name.endsWith('.jsonl')) continue;
      if (name.slice(0, 10) < cutoff) {
        await this.store.remove(`executions/${name}`);
        removed += 1;
      }
    }
    if (removed > 0) this.logger?.info?.('executions.pruned', { removed, cutoff });
    return { removed, cutoff };
  }

  /** @param {string} key @param {() => Promise<any>} fn */
  async #withLock(key, fn) {
    const previous = this.locks.get(key) || Promise.resolve();
    const next = previous.then(fn, fn);
    this.locks.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }
}

/** Компактная запись исполнения для списков. */
export function compactExecution(record) {
  if (!record) return null;
  return {
    id: record.id,
    at: record.at,
    runId: record.runId,
    service: record.service,
    operationType: record.operationType,
    operationName: record.operationName,
    status: record.status,
    ok: record.ok,
    durationMs: record.durationMs,
    test: record.test,
    fieldCount: record.analysis?.fieldCount || 0,
    valid: record.analysis?.valid ?? null,
    errorMessage: record.errorMessage || null,
    queryPreview: String(record.query || '').slice(0, 220),
  };
}
