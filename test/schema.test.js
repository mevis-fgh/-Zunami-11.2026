import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSchema } from 'graphql';
import { buildSchemaGraph } from '../src/schema/graph.js';
import { graphFromSdl, introspectEndpoint, normalizeHttpUrl } from '../src/schema/loader.js';
import { DEMO_SDL, startMockUpstream } from './helpers.js';

test('строит граф схемы: типы, поля, аргументы, связи', () => {
  const { graph } = graphFromSdl(DEMO_SDL);
  assert.deepEqual(graph.roots, { query: 'Query', mutation: null, subscription: null });
  assert.equal(graph.stats.fields, 6);
  assert.equal(graph.stats.args, 4);
  assert.equal(graph.stats.inputFields, 2);
  assert.ok(graph.fieldKeys.includes('User.name'));
  assert.ok(graph.argKeys.includes('User.friends.first'));
  assert.deepEqual(graph.inputKeys.sort(), ['UserFilter.role', 'UserFilter.search']);
  assert.deepEqual(graph.compositeTypes.sort(), ['Query', 'User']);

  const userEdge = graph.edges.find((edge) => edge.from === 'User' && edge.field === 'friends');
  assert.equal(userEdge.to, 'User');
  assert.equal(userEdge.leaf, false);

  const enumEdge = graph.edges.find((edge) => edge.from === 'User' && edge.field === 'role');
  assert.equal(enumEdge.leaf, true);
});

test('buildSchemaGraph проставляет корневые типы', () => {
  const schema = buildSchema(`
    schema { query: RootQuery }
    type RootQuery { hello: String }
  `);
  const graph = buildSchemaGraph(schema);
  assert.equal(graph.roots.query, 'RootQuery');
  assert.equal(graph.types.find((type) => type.name === 'RootQuery').isRoot, true);
});

test('некорректный SDL даёт 400', () => {
  assert.throws(
    () => graphFromSdl('type Query { broken: }'),
    (error) => error.status === 400,
  );
  assert.throws(
    () => graphFromSdl('type Foo { a: String }'),
    (error) => error.status === 400 && /Query/.test(error.message),
  );
});

test('introspection тянет схему с GraphQL-эндпоинта', async (t) => {
  const schema = buildSchema(DEMO_SDL);
  const upstream = await startMockUpstream({ schema });
  t.after(() => upstream.close());

  const result = await introspectEndpoint({ endpoint: upstream.url, timeoutMs: 5000 });
  assert.ok(result.sdl.includes('type User'));
  assert.ok(result.schema.getType('User'));
  assert.equal(result.schema.getQueryType().name, 'Query');
  assert.equal(upstream.calls.length, 1);
  assert.match(upstream.calls[0].body.query, /__schema/);
});

test('introspection сообщает об ошибках upstream', async (t) => {
  const broken = await startMockUpstream({ body: { errors: [{ message: 'introspection disabled' }] } });
  t.after(() => broken.close());
  await assert.rejects(
    () => introspectEndpoint({ endpoint: broken.url, timeoutMs: 5000 }),
    (error) => error.status === 502 && /ошибки introspection/i.test(error.message),
  );

  const notGraphql = await startMockUpstream({ body: { hello: 'world' } });
  t.after(() => notGraphql.close());
  await assert.rejects(
    () => introspectEndpoint({ endpoint: notGraphql.url, timeoutMs: 5000 }),
    (error) => error.status === 502,
  );
});

test('normalizeHttpUrl валидирует протокол', () => {
  assert.equal(normalizeHttpUrl('https://example.com/graphql'), 'https://example.com/graphql');
  assert.throws(() => normalizeHttpUrl('ftp://example.com'), (error) => error.status === 400);
  assert.throws(() => normalizeHttpUrl('not a url'), (error) => error.status === 400);
});
