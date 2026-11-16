# API

Базовый URL — адрес сервиса (`http://localhost:3000`). Все ответы — JSON, кроме CSV/JSON-экспорта,
SVG-бейджа и статики.

## Ошибки

```json
{ "error": { "message": "Прогон не найден", "code": "NOT_FOUND", "status": 404 } }
```

| Статус | Когда |
|---|---|
| `400` | невалидные параметры, пустой запрос, битый JSON |
| `401` | нужен `x-admin-token` / `x-proxy-key` |
| `403` | запрещённый target (SSRF, allowlist, override off) |
| `404` | нет схемы/прогона/запроса/эндпоинта |
| `413` | тело больше лимита |
| `502` | upstream недоступен или introspection вернул ошибку |
| `504` | upstream не ответил за `UPSTREAM_TIMEOUT_MS` |

## Аутентификация

- `ADMIN_TOKEN` — для `POST/PATCH/DELETE` в `/api/*` (кроме ingest — см. ниже: тоже требует).
  Передаётся заголовком `x-admin-token`.
- `PROXY_API_KEY` — для `/proxy`; заголовок `x-proxy-key` или `x-api-key`.
- Чтение (`GET /api/*`) открыто: его использует UI.

## Прокси

### `POST /proxy` (алиас `/graphql`)

Тело: `{ "query": "...", "variables": {}, "operationName": "..." }`,
`Content-Type: application/graphql` с сырым запросом или `GET /proxy?query=...&variables=...`.

Заголовки трекинга: `x-run-id`, `x-branch`, `x-team`, `x-environment`, `x-build-id`,
`x-commit`, `x-test-id`, `x-test-name` (значения с кириллицей — в percent-encoding).
Выбор сервиса: `?service=name` / `x-service`; override: `x-target-url` (если разрешён).

Ответ — ответ upstream 1:1 плюс диагностические заголовки:

```
x-coverage-proxy-request-id: req_...
x-coverage-proxy-run-id: ci-1042
x-coverage-proxy-service: default
x-coverage-proxy-fields: 12
x-coverage-proxy-valid: yes
```

```bash
curl -s http://localhost:3000/proxy \
  -H 'content-type: application/json' \
  -H 'x-run-id: demo' -H 'x-test-id: smoke' \
  -d '{"query":"{ me { id } }"}'
```

## Схема

| Метод | Путь | Тело/параметры |
|---|---|---|
| `GET` | `/api/schema` | `?id=` или `?service=`; по умолчанию активная |
| `GET` | `/api/schemas` | список снапшотов |
| `POST` | `/api/schema/introspect` | `{ endpoint?, headers?, service?, name? }` |
| `POST` | `/api/schema/sdl` | `{ sdl, name?, service? }` или `Content-Type: text/plain` |
| `POST` | `/api/schema/:id/activate` | — |
| `DELETE` | `/api/schema/:id` | — |

```bash
curl -s -X POST http://localhost:3000/api/schema/introspect \
  -H 'content-type: application/json' \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -d '{"endpoint":"https://api.example.com/graphql"}'
```

## Покрытие

### `GET /api/coverage`

Параметры (все опциональны, комбинируются):

| Параметр | Значение |
|---|---|
| `run` | один прогон |
| `runs` | список через запятую |
| `branch`, `team`, `env`, `service` | фильтры прогонов |
| `from`, `to` | даты (`YYYY-MM-DD` или ISO) |
| `schemaId` | снапшот схемы (иначе активный) |
| `include=summary` | не отдавать плоский массив `fields` |

Ответ:

```json
{
  "summary": {
    "fieldsTotal": 132, "fieldsCovered": 104, "fieldsPercent": 78.8,
    "typesTotal": 22, "typesCovered": 20, "typesPercent": 90.9,
    "argsTotal": 38, "argsCovered": 20, "argsPercent": 52.6,
    "requests": 42, "errors": 0, "invalid": 0, "tests": 18, "runs": 4,
    "maxDepth": 5,
    "testCoverage": { "tests": 18, "fieldsCovered": 104, "percent": 78.8 }
  },
  "types": [
    { "name": "Order", "kind": "OBJECT", "status": "partial", "percent": 93.3,
      "fieldsCovered": 14, "fieldsCount": 15,
      "fields": [ { "key": "Order.total", "covered": true, "hits": 5, "args": [] } ] }
  ],
  "fields": [ /* плоский список полей */ ],
  "topFields": [ { "key": "Product.id", "hits": 20 } ],
  "uncovered": [ { "key": "User.wishlist" } ],
  "operations": [ { "key": "query Orders", "count": 2 } ],
  "tests": [ { "key": "orders/list", "fieldsCovered": 12 } ],
  "runs": [ { "runId": "ci-1001-baseline", "percent": 31.1 } ]
}
```

Другие эндпоинты:

| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/api/coverage/type/:name` | тип + поля + связанные типы |
| `GET` | `/api/coverage/timeline` | точки по прогонам |
| `GET` | `/api/coverage/compare?base=&head=` | новые/потерянные/непокрытые |
| `GET` | `/api/coverage/gaps` | непокрытые поля |
| `GET` | `/api/coverage/export?format=csv\|json&what=fields\|types\|operations\|gaps` | экспорт |
| `GET` | `/api/coverage/badge?label=coverage` | SVG-бейдж |

## Прогоны

| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/api/runs?branch=&team=&env=&service=&from=&to=&q=&limit=&offset=` | список + фасеты |
| `POST` | `/api/runs` | `{ runId?, name?, branch?, team?, env?, build?, commit? }` |
| `GET` | `/api/runs/:id` | прогон + его покрытие/тесты/операции |
| `PATCH` | `/api/runs/:id` | `{ status, notes, ... }` |
| `DELETE` | `/api/runs/:id` | удалить прогон и покрытие |

## Журнал исполнений

| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/api/executions?run=&service=&type=&status=&test=&q=&from=&to=&limit=&offset=` | список |
| `GET` | `/api/executions/:id` | полный запрос: query, variables, поля, ошибки |

## Ingest (CI без прокси)

`POST /api/ingest` — загрузить уже выполненные запросы и получить покрытие.

```bash
curl -s -X POST http://localhost:3000/api/ingest \
  -H 'content-type: application/json' \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -d '{
    "run": { "runId": "ci-1042", "branch": "main", "team": "qa", "env": "staging", "build": "1042" },
    "test": { "id": "smoke", "name": "Smoke" },
    "queries": [
      { "query": "{ me { id email } }" },
      { "query": "query Orders { orders { id total } }", "test": { "id": "orders", "name": "Orders" } }
    ]
  }'
```

## Служебное

| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/healthz` | статус, версия, активная схема |
| `GET` | `/api/config` | публичная конфигурация (без секретов) |
| `GET` | `/api/stats` | агрегированная статистика |
| `GET` | `/api/state/export` | бэкап (admin) |
| `POST` | `/api/state/import` | восстановление (admin) |
| `POST` | `/api/demo/seed` | демо-данные на пустом хранилище (admin) |
