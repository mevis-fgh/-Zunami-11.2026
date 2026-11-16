import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSchema } from 'graphql';
import { analyzeDocument, summarizeAnalysis } from '../src/analyzer/analyzer.js';

const SDL = `
  schema { query: Query mutation: Mutation subscription: Subscription }

  type Query {
    user(id: ID!): User
    users(filter: UserFilter, first: Int = 10): [User!]!
    search(term: String!): [SearchResult!]!
  }

  type Mutation {
    updateUser(id: ID!, input: UserInput!): User!
  }

  type Subscription {
    userUpdated(id: ID!): User!
  }

  type User {
    id: ID!
    name: String!
    role: Role
    friends(first: Int): [User!]!
  }

  type Product { id: ID! title: String! }

  union SearchResult = User | Product

  enum Role { ADMIN USER }

  input UserFilter { role: Role search: String }
  input UserInput { name: String role: Role }
`;

const schema = buildSchema(SDL);

const keys = (analysis) => analysis.fields.filter((field) => field.resolved).map((field) => field.key);
const argKeys = (analysis) => analysis.args.filter((arg) => arg.resolved).map((arg) => arg.key);

test('анализирует простой query: типы, поля, аргументы, глубину', () => {
  const analysis = analyzeDocument({ query: '{ user(id: "1") { id name } }', schema });
  assert.equal(analysis.parsed, true);
  assert.equal(analysis.valid, true);
  assert.equal(analysis.operations.length, 1);
  assert.equal(analysis.operations[0].type, 'query');
  assert.equal(analysis.maxDepth, 2);
  assert.deepEqual(keys(analysis).sort(), ['Query.user', 'User.id', 'User.name']);
  assert.deepEqual(argKeys(analysis), ['Query.user.id']);
  assert.equal(analysis.totals.fields, 3);
});

test('алиасы маппятся на реальные имена полей', () => {
  const analysis = analyzeDocument({ query: '{ u: user(id: "1") { n: name } }', schema });
  const nameField = analysis.fields.find((field) => field.key === 'User.name');
  assert.equal(nameField.alias, 'n');
  assert.equal(nameField.path, 'u.n');
  const rootField = analysis.fields.find((field) => field.key === 'Query.user');
  assert.equal(rootField.alias, 'u');
  assert.equal(rootField.path, 'u');
});

test('разворачивает именованные и inline-фрагменты, считает вложенность', () => {
  const query = `
    query Q($id: ID!) {
      user(id: $id) {
        ...UserFields
        ... on User { role }
      }
    }
    fragment UserFields on User { id name friends(first: 2) { id } }
  `;
  const analysis = analyzeDocument({ query, schema });
  assert.equal(analysis.valid, true);
  assert.equal(analysis.maxDepth, 3);
  const fieldKeys = new Set(keys(analysis));
  assert.deepEqual([...fieldKeys].sort(), ['Query.user', 'User.friends', 'User.id', 'User.name', 'User.role']);
  assert.equal(analysis.fragments.length, 1);
  assert.equal(analysis.fragments[0].name, 'UserFields');
  assert.equal(analysis.fragments[0].usage, 1);
  assert.deepEqual(argKeys(analysis).sort(), ['Query.user.id', 'User.friends.first']);
});

test('дедуплицирует одинаковые выборки, но сохраняет разные алиасы', () => {
  const query = `query Q { user(id: "1") { ...F ...F } } fragment F on User { id }`;
  const analysis = analyzeDocument({ query, schema });
  assert.equal(keys(analysis).length, 2); // Query.user + User.id

  const aliased = analyzeDocument({ query: '{ user(id: "1") { a: name b: name } }', schema });
  assert.equal(aliased.fields.filter((field) => field.key === 'User.name').length, 2);
});

test('переменные: определения, использование в аргументах и глубина', () => {
  const query = `query Q($id: ID!, $first: Int) { user(id: $id) { friends(first: $first) { id } } }`;
  const analysis = analyzeDocument({ query, schema });
  assert.deepEqual(
    analysis.variables.map((variable) => [variable.name, variable.used]),
    [
      ['id', true],
      ['first', true],
    ],
  );
  const idArg = analysis.args.find((arg) => arg.key === 'Query.user.id');
  assert.equal(idArg.valueKind, 'Variable');
  assert.equal(idArg.variable, 'id');
});

test('литеральные input-объекты раскрываются до полей', () => {
  const analysis = analyzeDocument({
    query: '{ users(filter: { role: ADMIN, search: "x" }) { id } }',
    schema,
  });
  assert.deepEqual(
    analysis.inputs.filter((input) => input.resolved).map((input) => input.key).sort(),
    ['UserFilter.role', 'UserFilter.search'],
  );
});

test('mutation и subscription определяются по operation type', () => {
  const mutation = analyzeDocument({
    query: 'mutation M { updateUser(id: "1", input: { name: "x", role: ADMIN }) { id } }',
    schema,
  });
  assert.equal(mutation.operations[0].type, 'mutation');
  assert.equal(mutation.operations[0].rootType, 'Mutation');
  assert.deepEqual(
    mutation.inputs.filter((input) => input.resolved).map((input) => input.key).sort(),
    ['UserInput.name', 'UserInput.role'],
  );

  const subscription = analyzeDocument({ query: 'subscription S { userUpdated(id: "1") { id } }', schema });
  assert.equal(subscription.operations[0].type, 'subscription');
  assert.equal(subscription.operations[0].rootType, 'Subscription');
});

test('фрагменты на union типах через inline fragments', () => {
  const query = '{ search(term: "x") { __typename ... on User { id name } ... on Product { id title } } }';
  const analysis = analyzeDocument({ query, schema });
  assert.equal(analysis.valid, true);
  const fieldKeys = new Set(keys(analysis));
  assert.ok(fieldKeys.has('User.name'));
  assert.ok(fieldKeys.has('Product.title'));
  assert.ok(!fieldKeys.has('SearchResult.__typename'));
});

test('невалидные запросы: parse error и неизвестное поле', () => {
  const broken = analyzeDocument({ query: '{ user( }', schema });
  assert.equal(broken.parsed, false);
  assert.equal(broken.errors[0].code, 'PARSE_ERROR');

  const unknown = analyzeDocument({ query: '{ user(id: "1") { nope } }', schema });
  assert.equal(unknown.parsed, true);
  assert.equal(unknown.valid, false);
  assert.ok(unknown.errors.some((error) => error.code === 'VALIDATION_ERROR'));
  assert.ok(unknown.unresolved.some((item) => item.field === 'nope'));
  assert.ok(!keys(unknown).includes('User.nope'));
});

test('operationName выбирает исполняемую операцию', () => {
  const query = 'query A { user(id: "1") { id } } query B { users { name } }';
  const withoutName = analyzeDocument({ query, schema });
  assert.ok(withoutName.errors.some((error) => error.code === 'OPERATION_NAME_REQUIRED'));

  const analysis = analyzeDocument({ query, schema, operationName: 'B' });
  assert.deepEqual(
    analysis.operations.map((operation) => [operation.name, operation.executed]),
    [
      ['A', false],
      ['B', true],
    ],
  );
  const summary = summarizeAnalysis(analysis);
  assert.deepEqual(summary.fields.sort(), ['Query.users', 'User.name']);
});

test('директивы собираются в список', () => {
  const analysis = analyzeDocument({
    query: 'query Q($skip: Boolean!) { user(id: "1") @include(if: $skip) { id } }',
    schema,
  });
  assert.ok(analysis.directives.includes('include'));
});

test('пустой и слишком большой запрос отклоняются', () => {
  const empty = analyzeDocument({ query: '   ', schema });
  assert.equal(empty.parsed, false);
  assert.equal(empty.errors[0].code, 'EMPTY_QUERY');
});
