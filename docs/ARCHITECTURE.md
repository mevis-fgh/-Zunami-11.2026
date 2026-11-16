# Архитектура

## Обзор

Сервис — один Node.js-процесс (Express), который совмещает три роли:

1. **Прокси** GraphQL-запросов (`/proxy`).
2. **REST API** для UI и CI (`/api/*`).
3. **SPA** с визуализацией (`/`, статика без сборки).

Состояние хранится в файлах внутри `DATA_DIR`; внешняя БД не требуется.

```
┌─────────────────────────────────────────────────────────────────────┐
│ Express                                                             │
│                                                                     │
│  CORS → request-id → body parsers                                   │
│     │                                                               │
│     ├── /healthz                                                    │
│     ├── /proxy, /graphql ──► proxy-router ──► analyzer ──► repository│
│     ├── /api/* ────────────► api-router ────► repository/view        │
│     └── /* ─────────────────► public/ (SPA)                         │
└─────────────────────────────────────────────────────────────────────┘
        │                                  ▲
        ▼                                  │
  upstream GraphQL                 DATA_DIR (JSON + JSONL)
```

## Модули

| Модуль | Ответственность |
|---|---|
| `src/config.js` | разбор env, безопасные дефолты, публичная конфигурация для UI |
| `src/app.js` | сборка Express: CORS, healthz, парсеры, роутеры, SPA, error handler |
| `src/proxy/proxy-router.js` | приём запроса, трекинг прогона, вызов upstream, запись исполнения |
| `src/proxy/targets.js` | выбор сервиса/URL, SSRF-защита, allowlist хостов |
| `src/schema/loader.js` | introspection-запрос, парсинг SDL, нормализация |
| `src/schema/graph.js` | внутренний граф: типы, поля, аргументы, связи, ключи покрытия |
| `src/schema/registry.js` | кэш `GraphQLSchema` по снапшоту (для анализа) |
| `src/analyzer/analyzer.js` | AST → операции, поля, аргументы, input-поля, переменные, глубина |
| `src/coverage/stats.js` | агрегаты прогона, слияние прогонов, абсолютные метрики |
| `src/coverage/view.js` | представление покрытия для UI, diff прогонов, timeline |
| `src/coverage/export.js` | CSV и SVG-бейдж |
| `src/storage/json-store.js` | атомарная запись, очередь на файл, JSONL |
| `src/storage/repository.js` | схемы, прогоны, исполнения, покрытие, экспорт/импорт |
| `src/api/routes.js` | REST API |
| `src/demo/seed.js` | демо-схема и демо-прогоны |

## Жизненный цикл запроса через прокси

1. **Маршрутизация.** `POST /proxy` (также `GET /proxy`, `POST /graphql`).
2. **Аутентификация.** Если задан `PROXY_API_KEY`, проверяется `x-proxy-key`/`x-api-key`
   (сравнение constant-time).
3. **Выбор цели.** `?service=` / `x-service` → сервис из `SERVICES_JSON`; `x-target-url`
   допускается только при `ALLOW_TARGET_OVERRIDE=true` и проходит allowlist/private-проверку.
4. **Контекст прогона.** Из заголовков `x-run-id`, `x-branch`, `x-team`, `x-environment`,
   `x-build-id`, `x-commit`, `x-test-id`/`x-test-name`. Без `x-run-id` создаётся
   детерминированный авто-прогон.
5. **Разбор.** `analyzeDocument(query, schema, operationName)`:
   AST, валидация по схеме, поля/аргументы/операции/глубина.
6. **Пересылка.** Все заголовки клиента, кроме hop-by-hop и трекинговых, уходят на upstream.
   Тело нормализуется в JSON `{query, variables, operationName}`.
7. **Ответ.** Статус и заголовки upstream пробрасываются 1:1 (кроме `content-encoding`/
   `content-length`), тело — как есть. Для `text/event-stream` и больших ответов — поток.
8. **Запись.** Сначала JSONL-исполнение, затем агрегат покрытия прогона (обе операции
   сериализованы очередями). Клиент получает ответ после фиксации, чтобы UI и тесты видели
   согласованное состояние.

Ошибки upstream (сеть, таймаут) → `502` с `extensions.code = UPSTREAM_UNAVAILABLE|UPSTREAM_TIMEOUT`.
Запрос при этом попадает в покрытие как «отправленный»: тест действительно дошёл до этого поля.

## Разбор запроса

Поддерживается:

- `query` / `mutation` / `subscription`;
- алиасы: в покрытие пишется **реальное имя поля**, алиас сохраняется в пути;
- именованные фрагменты (с защитой от циклов), inline fragments, фрагменты на union/interface;
- переменные: определения, использование, `used`-флаг;
- аргументы полей и литеральные input-объекты (рекурсивно, списки и вложенные объекты);
- директивы (`@include`, `@skip`, кастомные);
- дедупликация одинаковых путей внутри операции (фрагмент, вставленный дважды, не удваивает счётчик);
- ограничение глубины (`64`) и размера запроса.

`__typename` и introspection-поля исключаются из покрытия.

## Модель данных

```
DATA_DIR/
  schema-active.json         { schemaId }
  schemas/<schemaId>.json    { id, service, source, createdAt, sdl, graph, stats }
  runs/<runId>.json          { runId, branch, team, env, build, commit, schemaId,
                               requests, fieldsCovered, fieldsTotal, percent, ... }
  coverage/<runId>.json      { fields: {"User.name": {hits, tests, depth}}, args, inputs,
                               types, operations, tests, stats }
  executions/2026-11-16.jsonl  по строке на запрос
  state-*.json               (экспорт) 
```

Идентификатор прогона — `[A-Za-z0-9][A-Za-z0-9._:-]{0,119}`; всё, что попадает в путь
файла, валидируется (защита от path traversal).

### Ключи покрытия

| Сущность | Ключ | Пример |
|---|---|---|
| поле | `Type.field` | `Order.total` |
| аргумент | `Type.field.arg` | `Query.orders.status` |
| input-поле | `InputType.field` | `CreateOrderInput.addressId` |
| тип | `Type` | `Order` |
| операция | `query Name` / `mutation Name` | `query Orders` |

### Метрики

- `fieldsPercent = fieldsCovered / fieldsTotal` по выходным полям `OBJECT` и `INTERFACE`.
- `typesPercent` — доля составных типов, у которых был хотя бы один выбранный field.
- `argsPercent` — доля аргументов полей, которые встречались в запросах.
- `testCoverage` — те же поля, но только те, что задел именованный тест-кейс.
- `hits` — количество появлений выбора в запросах (разные пути считаются отдельно).

`schema coverage` и `test coverage` отвечают на разные вопросы: первое — «что вообще видел
трафик» (включая ручные запросы и health-check), второе — «что реально проверяют тесты».

## Согласованность и конкурентность

- `JsonStore` сериализует операции по каждому файлу и пишет атомарно (`tmp` + `rename`).
- Агрегат покрытия прогона обновляется под локом `coverage:<runId>`, поэтому параллельные
  запросы не теряют инкременты.
- Схемы иммутабельны: id — хеш `service + SDL`. Перезагрузка той же схемы переиспользует
  снапшот, а покрытие привязано к `schemaId` прогона.
- Журнал исполнений — append-only, ротация по дням, очистка старше `RETENTION_DAYS`.

## Безопасность

| Риск | Мера |
|---|---|
| SSRF через target override | `ALLOW_TARGET_OVERRIDE=false` по умолчанию, allowlist хостов, запрет private-сетей в production |
| Публичный прокси | `PROXY_API_KEY` + constant-time сравнение |
| Загрузка схем/ingest | `ADMIN_TOKEN` для всех изменяющих эндпоинтов |
| Утечка секретов в UI | `/api/config` возвращает только маски |
| Path traversal | валидация id и `JsonStore.resolve` |
| Огромные тела | лимиты `MAX_BODY_MB`, `MAX_RESPONSE_MB`, `MAX_QUERY_CHARS` |
| Шумные логи | структурные JSON-логи без тел запросов и токенов |

## Масштабирование

Текущая схема — один инстанс на свой `DATA_DIR`. Для нескольких реплик:

1. вынести `repository` за интерфейс и добавить адаптер Postgres/Redis;
2. хранить агрегаты в таблице `coverage(run_id, key, hits)` с upsert;
3. журнал — в ClickHouse/Postgres вместо JSONL;
4. снапшоты схем — в объектное хранилище (S3/R2) с кэшем в процессе.

Read-эндпоинты (`/api/coverage`, `/api/runs`) не зависят от записи и могут кэшироваться
на CDN при необходимости.

## Тестирование

`node:test` без внешних зависимостей:

- `analyzer.test.js` — AST, фрагменты, алиасы, переменные, input-литералы;
- `schema.test.js` — граф, SDL, introspection через моковый GraphQL-сервер;
- `coverage.test.js` — агрегация, проценты, diff;
- `storage.test.js` — атомарность, очереди, прогоны, экспорт/импорт;
- `proxy.test.js` — пересылка, SSRF, стриминг, ошибки, строгий режим;
- `api.test.js` — все REST-эндпоинты, auth, CORS, SPA.
