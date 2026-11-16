import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Простое надёжное JSON-хранилище на файловой системе:
 * - атомарная запись (tmp + rename),
 * - последовательная очередь на каждый файл (без гонок),
 * - append-only JSONL для журнала исполнений.
 *
 * Никаких нативных зависимостей — одинаково работает локально, в Docker и на Render.
 */
export class JsonStore {
  /** @type {Map<string, Promise<unknown>>} */
  #queues = new Map();

  /**
   * @param {{ dir: string, logger?: any }} options
   */
  constructor({ dir, logger }) {
    this.dir = path.resolve(dir);
    this.logger = logger;
  }

  /**
   * @param {string} name относительный путь внутри data-dir
   */
  resolve(name) {
    const relative = String(name).replace(/\\/g, '/');
    const absolute = path.resolve(this.dir, relative);
    if (absolute !== this.dir && !absolute.startsWith(`${this.dir}${path.sep}`)) {
      throw new Error(`Путь выходит за пределы data-dir: ${name}`);
    }
    return absolute;
  }

  /** @param {string} name */
  async mkdir(name) {
    await fs.mkdir(this.resolve(name), { recursive: true });
  }

  /**
   * Сериализует операции над одним и тем же ключом.
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  #serialize(key, fn) {
    const previous = this.#queues.get(key) || Promise.resolve();
    const next = previous.then(
      () => fn(),
      () => fn(),
    );
    this.#queues.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /**
   * @template T
   * @param {string} name
   * @param {T} [fallback]
   * @returns {Promise<T>}
   */
  async read(name, fallback) {
    const file = this.resolve(name);
    try {
      const raw = await fs.readFile(file, 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      if (error?.code === 'ENOENT') return fallback;
      if (error instanceof SyntaxError) {
        this.logger?.warn?.('json.corrupted', { file: name, message: error.message });
        return fallback;
      }
      throw error;
    }
  }

  /**
   * Атомарная запись JSON.
   * @param {string} name
   * @param {unknown} data
   */
  async write(name, data) {
    return this.#serialize(`w:${name}`, async () => {
      const file = this.resolve(name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
      const payload = `${JSON.stringify(data)}\n`;
      await fs.writeFile(tmp, payload, 'utf8');
      await fs.rename(tmp, file);
      return data;
    });
  }

  /**
   * Дозапись строки в JSONL.
   * @param {string} name
   * @param {unknown} record
   */
  async appendLine(name, record) {
    return this.#serialize(`a:${name}`, async () => {
      const file = this.resolve(name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
    });
  }

  /**
   * Читает JSONL-файл построчно, пропуская битые строки.
   * @param {string} name
   * @returns {Promise<any[]>}
   */
  async readLines(name) {
    const file = this.resolve(name);
    let raw;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const out = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed));
      } catch {
        // битая строка (например, обрыв записи) — пропускаем
      }
    }
    return out;
  }

  /**
   * @param {string} name
   * @returns {Promise<string[]>}
   */
  async listDir(name) {
    try {
      return (await fs.readdir(this.resolve(name))).sort();
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  /** @param {string} name */
  async remove(name) {
    const file = this.resolve(name);
    await fs.rm(file, { force: true });
  }

  /** @param {string} name */
  async exists(name) {
    try {
      await fs.access(this.resolve(name));
      return true;
    } catch {
      return false;
    }
  }
}
