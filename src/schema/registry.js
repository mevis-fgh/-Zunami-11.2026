import { buildSchema } from 'graphql';

/**
 * Кэш исполняемых GraphQLSchema-объектов для анализа запросов.
 * Снапшоты хранятся в SDL — schema-объект собирается один раз на снапшот.
 */
export class SchemaRegistry {
  /**
   * @param {{ repository: import('../storage/repository.js').Repository, logger: any }} options
   */
  constructor({ repository, logger }) {
    this.repository = repository;
    this.logger = logger;
    /** @type {Map<string, any>} */
    this.cache = new Map();
  }

  /** @param {string} schemaId */
  get(schemaId) {
    if (!schemaId) return null;
    const snapshot = this.repository.getSchema(schemaId);
    if (!snapshot) return null;
    const cached = this.cache.get(schemaId);
    if (cached && cached.createdAt === snapshot.createdAt) return cached;
    try {
      const schema = buildSchema(snapshot.sdl);
      const entry = {
        id: snapshot.id,
        name: snapshot.name,
        service: snapshot.service,
        createdAt: snapshot.createdAt,
        snapshot,
        graph: snapshot.graph,
        schema,
      };
      this.cache.set(schemaId, entry);
      return entry;
    } catch (error) {
      this.logger?.error?.('schema.build_failed', { schemaId, message: error?.message || String(error) });
      return null;
    }
  }

  getActive() {
    return this.get(this.repository.activeSchemaId);
  }

  /** @param {string} schemaId */
  invalidate(schemaId) {
    if (schemaId) this.cache.delete(schemaId);
    else this.cache.clear();
  }
}
