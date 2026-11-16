import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { graphql } from 'graphql';

let counter = 0;

/**
 * Поднимает изолированный экземпляр приложения на свободном порту.
 * @param {{ seed?: boolean, env?: Record<string, string> }} [options]
 */
export async function startTestApp({ seed = false, env = {} } = {}) {
  const { createApp } = await import('../src/app.js');
  const { loadConfig } = await import('../src/config.js');
  const { seedDemo } = await import('../src/demo/seed.js');
  const { SchemaRegistry } = await import('../src/schema/registry.js');
  const { Repository } = await import('../src/storage/repository.js');
  const { createLogger } = await import('../src/utils/logger.js');

  counter += 1;
  const dir = path.join(process.cwd(), '.tmp-tests', `run-${Date.now()}-${counter}`);
  await fs.rm(dir, { recursive: true, force: true });

  const config = loadConfig({
    PATH: process.env.PATH,
    DATA_DIR: dir,
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
    AUTO_INTROSPECT: 'false',
    ALLOW_PRIVATE_TARGETS: 'true',
    ...env,
  });
  const logger = createLogger({ level: 'silent' });
  const repository = await new Repository({ config, logger }).init();
  if (seed) await seedDemo({ repository, logger });
  const registry = new SchemaRegistry({ repository, logger });
  const app = createApp({ config, repository, registry, logger });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    app,
    config,
    repository,
    registry,
    server,
    base,
    dir,
    logger,
    async cleanup() {
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * @param {string} base
 * @param {string} url
 * @param {RequestInit} [options]
 */
export async function request(base, url, options = {}) {
  const response = await fetch(`${base}${url}`, options);
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { response, status: response.status, text, json, headers: response.headers };
}

/**
 * Мок GraphQL-сервера. Отвечает на introspection и обычные запросы.
 * @param {{ schema?: import('graphql').GraphQLSchema, status?: number, body?: any, headers?: Record<string,string> }} [options]
 */
export async function startMockUpstream({ schema = null, status = 200, body = null, headers = {} } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', async () => {
      const payload = parseJson(raw);
      calls.push({ method: req.method, url: req.url, headers: req.headers, body: payload, raw });
      if (body !== null) {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
        return;
      }
      if (schema && payload?.query) {
        const result = await graphql({
          schema,
          source: payload.query,
          operationName: payload.operationName || undefined,
          variableValues: payload.variables || undefined,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { ok: true, calls: calls.length } }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    server,
    calls,
    url: `http://127.0.0.1:${server.address().port}/graphql`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export const DEMO_SDL = `
  enum Role { ADMIN USER }

  input UserFilter { role: Role search: String }

  type Query {
    user(id: ID!): User
    users(filter: UserFilter, first: Int = 10): [User!]!
  }

  type User {
    id: ID!
    name: String!
    role: Role
    friends(first: Int): [User!]!
  }
`;

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
