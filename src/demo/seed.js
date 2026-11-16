import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { analyzeDocument, summarizeAnalysis } from '../analyzer/analyzer.js';
import { buildSchemaGraph } from '../schema/graph.js';
import { schemaFromSdl } from '../schema/loader.js';
import { newId } from '../utils/id.js';

const SDL_PATH = new URL('../../examples/demo-schema.graphql', import.meta.url);

/**
 * Демо-данные для витрины: схема магазина + 4 прогона с растущим покрытием.
 * Включается переменной DEMO_MODE=true и только на пустом хранилище.
 */
export async function seedDemo({ repository, logger }) {
  if (repository.schemas.size > 0) {
    return { seeded: false, reason: 'schema-already-exists' };
  }

  const sdl = await fs.readFile(fileURLToPath(SDL_PATH), 'utf8');
  const { schema } = schemaFromSdl(sdl);
  const graph = buildSchemaGraph(schema);
  await repository.saveSchema({
    sdl,
    graph,
    source: 'demo',
    service: 'demo',
    endpoint: 'demo://shop/graphql',
    name: 'Demo Shop (интернет-магазин)',
  });

  const now = Date.now();
  let executions = 0;

  for (const [index, spec] of DEMO_RUNS.entries()) {
    const startedAt = new Date(now - (DEMO_RUNS.length - index) * 86400000).toISOString();
    const run = await repository.ensureRun({
      runId: spec.runId,
      name: spec.name,
      branch: spec.branch,
      team: spec.team,
      env: spec.env,
      build: spec.build,
      source: 'demo',
      service: 'demo',
    });
    run.startedAt = startedAt;
    run.createdAt = startedAt;
    run.notes = spec.notes || '';

    let cursor = Date.parse(startedAt);
    let sequence = 0;
    const queries = DEMO_QUERIES.slice(0, spec.upto);

    for (const item of queries) {
      cursor += 45_000;
      const at = new Date(cursor).toISOString();
      const analysis = analyzeDocument({ query: item.query, schema });
      const test = { key: item.test, name: item.testName || item.test };
      await repository.applyCoverage({ run, analysis, test, ok: true, parsed: true, at });
      await repository.recordExecution({
        id: newId('req'),
        at,
        runId: run.runId,
        service: 'demo',
        targetUrl: 'demo://shop/graphql',
        method: 'POST',
        operationType: analysis.operations.find((operation) => operation.executed)?.type || 'query',
        operationName: analysis.operations.find((operation) => operation.executed)?.name || null,
        status: 200,
        ok: true,
        durationMs: 18 + ((sequence * 7) % 90),
        query: item.query,
        variables: item.variables || null,
        test,
        client: { ip: '127.0.0.1', userAgent: 'demo-seed' },
        analysis: summarizeAnalysis(analysis),
        errors: [],
        responsePreview: '{"data": {…demo…}}',
        errorMessage: null,
        demo: true,
      });
      executions += 1;
      sequence += 1;
    }

    run.status = 'finished';
    run.finishedAt = new Date(cursor + 30_000).toISOString();
    await repository.saveRun(run);
  }

  logger?.info?.('demo.seeded', { runs: DEMO_RUNS.length, executions });
  return { seeded: true, runs: DEMO_RUNS.length, executions };
}

/**
 * Полный набор «тестов» демо-набора. Прогоны кумулятивные: build N запускает
 * все сценарии предыдущих build-ов плюс новые, как в реальном CI.
 */
const DEMO_QUERIES = [
  // --- baseline: авторизация и каталог ---
  {
    test: 'auth/me',
    testName: 'Профиль текущего пользователя',
    query: `query GetMe { me { id email name role status avatarUrl createdAt } }`,
  },
  {
    test: 'users/detail',
    testName: 'Карточка пользователя',
    query: `query GetUser($id: ID!) { user(id: $id) { id name email role addresses { id city country isDefault } } }`,
    variables: { id: 'u_1' },
  },
  {
    test: 'catalog/list',
    testName: 'Список товаров',
    query: `query BrowseProducts($first: Int, $filter: ProductFilter) {
      products(first: $first, filter: $filter) {
        edges { node { id title slug price currency rating inStock images { url alt } category { id slug name } } cursor }
        pageInfo { hasNextPage endCursor }
        totalCount
      }
    }`,
    variables: { first: 20, filter: { inStock: true } },
  },
  {
    test: 'catalog/card',
    testName: 'Карточка товара',
    query: `query ProductCard($id: ID!) { product(id: $id) { id sku title price compareAtPrice reviewCount tags } }`,
    variables: { id: 'p_1' },
  },

  // --- поиск, логин, корзина ---
  {
    test: 'search/all',
    testName: 'Поиск по всем типам',
    query: `query Search($term: String!, $types: [SearchType!]) {
      search(term: $term, types: $types) {
        __typename
        ... on Product { id title price }
        ... on User { id name }
        ... on Order { id number status }
      }
    }`,
    variables: { term: 'phone' },
  },
  {
    test: 'auth/login',
    testName: 'Логин',
    query: `mutation Login($email: String!, $password: String!) {
      login(email: $email, password: $password) { token refreshToken user { id name role } }
    }`,
    variables: { email: 'qa@example.com', password: 'secret' },
  },
  {
    test: 'cart/add',
    testName: 'Добавление в корзину',
    query: `mutation AddToCart($productId: ID!, $qty: Int!) {
      addToCart(productId: $productId, quantity: $qty) {
        id items { id quantity price product { id title } } subtotal total currency updatedAt
      }
    }`,
    variables: { productId: 'p_1', qty: 2 },
  },
  {
    test: 'cart/view',
    testName: 'Просмотр корзины',
    query: `query CartView { me { cart { id items { id quantity price product { id title price } } total currency } } }`,
  },

  // --- оформление и заказы ---
  {
    test: 'checkout/create',
    testName: 'Создание заказа',
    query: `mutation CreateOrder {
      createOrder(input: { items: [{ productId: "p_1", quantity: 1 }], addressId: "a_1", couponCode: "QA10" }) {
        id number status total currency createdAt items { id title quantity total }
      }
    }`,
  },
  {
    test: 'orders/list',
    testName: 'Список заказов',
    query: `query Orders($status: OrderStatus) {
      orders(status: $status) {
        id number status subtotal shipping discount total createdAt paidAt
        items { product { id title } quantity price }
        shippingAddress { city zip country }
      }
    }`,
    variables: { status: 'PAID' },
  },
  {
    test: 'orders/detail',
    testName: 'Детали заказа',
    query: `query OrderDetail($id: ID!) {
      order(id: $id) {
        id number status trackingNumber
        customer { id name email }
        items { title quantity price total }
        shippingAddress { street city zip }
      }
    }`,
    variables: { id: 'o_1' },
  },
  {
    test: 'profile/update',
    testName: 'Обновление профиля',
    query: `mutation UpdateProfile($input: UpdateProfileInput!) { updateProfile(input: $input) { id name avatarUrl } }`,
    variables: { input: { name: 'QA Bot', avatarUrl: 'https://example.com/a.png' } },
  },

  // --- админка, отзывы, метрики, подписки ---
  {
    test: 'catalog/categories',
    testName: 'Дерево категорий',
    query: `query Categories { categories { id slug name children { id slug name } parent { id name } } }`,
  },
  {
    test: 'reviews/add',
    testName: 'Добавление отзыва',
    query: `mutation AddReview($productId: ID!, $input: ReviewInput!) {
      addReview(productId: $productId, input: $input) { id rating text helpfulCount author { id name } createdAt }
    }`,
    variables: { productId: 'p_1', input: { rating: 5, text: 'Отлично!' } },
  },
  {
    test: 'reviews/mine',
    testName: 'Мои отзывы',
    query: `query UserReviews { me { reviews { ...ReviewParts } } } fragment ReviewParts on Review { id rating text helpfulCount author { id name } }`,
  },
  {
    test: 'admin/metrics',
    testName: 'Метрики магазина',
    query: `query Metrics($from: DateTime!, $to: DateTime!) {
      metrics(from: $from, to: $to) { orders revenue averageOrderValue newUsers conversionRate topProducts { id title } }
    }`,
    variables: { from: '2026-01-01T00:00:00Z', to: '2026-11-01T00:00:00Z' },
  },
  {
    test: 'orders/cancel',
    testName: 'Отмена заказа',
    query: `mutation CancelOrder($id: ID!) { cancelOrder(id: $id) { id status } }`,
    variables: { id: 'o_2' },
  },
  {
    test: 'realtime/order',
    testName: 'Подписка на заказ',
    query: `subscription OnOrderUpdated($orderId: ID!) { orderUpdated(orderId: $orderId) { id status total } }`,
    variables: { orderId: 'o_1' },
  },
];

const DEMO_RUNS = [
  {
    runId: 'ci-1001-baseline',
    name: 'CI #1001 · baseline',
    branch: 'main',
    team: 'qa',
    env: 'staging',
    build: '1001',
    notes: 'Базовый прогон: авторизация и каталог.',
    upto: 4,
  },
  {
    runId: 'ci-1002-cart',
    name: 'CI #1002 · поиск и корзина',
    branch: 'main',
    team: 'qa',
    env: 'staging',
    build: '1002',
    notes: 'Добавлены поиск, логин и работа с корзиной.',
    upto: 8,
  },
  {
    runId: 'ci-1003-checkout',
    name: 'CI #1003 · оформление заказа',
    branch: 'release/1.2',
    team: 'qa',
    env: 'staging',
    build: '1003',
    notes: 'Оформление, список и детализация заказов.',
    upto: 12,
  },
  {
    runId: 'ci-1004-extended',
    name: 'CI #1004 · расширенный',
    branch: 'release/1.2',
    team: 'qa',
    env: 'production',
    build: '1004',
    notes: 'Админка, отзывы, метрики и подписки.',
    upto: DEMO_QUERIES.length,
  },
];
