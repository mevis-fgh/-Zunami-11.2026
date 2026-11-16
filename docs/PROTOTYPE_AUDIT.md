# Аудит исходного прототипа (`backend/backend.py` + `backend/frontend.html`)

Прототип «God Eye v4.0» — FastAPI + SQLite + graphql-core, один файл бэкенда (722 строки)
и один HTML-файл (35 КБ) с React UMD и Babel в браузере. Ниже — что в нём уже было
и чего не хватало относительно концепции.

## Что в прототипе уже работало

- FastAPI-приложение, SQLite-хранилище (`schema_snapshots`, `runs`, `execution_log`,
  `field_hits`, `type_hits`, `test_case_hits`).
- `POST /graphql`: разбор запроса, запись попаданий, ответ upstream (`httpx`) или мок.
- Разбор через `graphql-core` `TypeInfoVisitor`: типы и поля.
- Эндпоинты: `summary`, `fields`, `hot`, `field/{type}/{field}/queries`,
  `history`, `runs`, `runs/new`, `runs/{id}/activate|reset`, `diff`, `export`,
  `timeline`, `demo`, `send-query`.
- WebSocket `/api/ws/coverage` с живыми дельтами покрытия.
- Простой UI на React (CDN) с графиком и таблицами.

## Чего не хватало относительно ТЗ

| Требование ТЗ | Состояние в прототипе |
|---|---|
| Схема через introspection **или SDL** | схема **жёстко зашита** в `SCHEMA_SDL`; introspection-функции импортированы, но не используются; загрузки SDL и переключения снапшотов нет |
| Снапшот схемы | в БД пишется только `sdl_preview` (200 символов), полноценного снапшота нет |
| Аргументы | не считаются вовсе |
| Вложенность / глубина | не считается |
| Алиасы | отдельно не маппятся (только через `TypeInfo`) |
| Фрагменты | обрабатываются частично, без явного учёта и дедупликации |
| Переменные | не анализируются |
| Операции | сохраняется только тип/имя первой операции; счётчиков по операциям нет |
| Покрытие по операциям и вложенности | отсутствует |
| Schema / test coverage как два разреза | `test_case_hits` пишутся, но в сводку не попадают |
| Прогоны: env/build/commit | только `run_key`, `branch`, `team` |
| Фильтры по ветке/окружению/дате | нет (только `run_id`) |
| Сравнение прогонов | есть API `/api/diff`, в UI не выведено |
| Экспорт JSON/CSV | есть, только по одному прогону |
| Проксирование реального backend | по умолчанию **mock-режим** (генерирует фейковые данные), если не задан `GRAPHQL_TARGET_URL` |
| Безопасность | CORS `*`, авторизации нет, лимитов нет, SSRF-защиты нет |
| Тесты | только `/api/selftest` и startup self-test; автотестов нет |
| Деплой | нет `requirements.txt`, `render.yaml`, `Dockerfile`, README; фронт грузит React/Babel с CDN |
| Разбиение на файлы | 722 строки в одном `backend.py`, 35 КБ в одном `frontend.html` |

## Вывод

Прототип — хорошая демонстрация идеи, но он не покрывает обязательные пункты концепции
(загрузка схемы, аргументы, операции, вложенность, окружения/даты, разрезы покрытия)
и не готов к деплою на Render.

Поэтому в этом репозитории собрана production-версия, закрывающая все требования:
модульный backend в `src/`, SPA без сборки в `public/`, `render.yaml`, Dockerfile, CI,
52 автотеста и матрица соответствия `docs/REQUIREMENTS.md`.

Прототип сохранён без изменений в `backend/` — как история решения и для сверки поведения.
Он **не участвует** в сборке и деплое (исключён в `.dockerignore`).

## Миграция вызовов прототипа

| Прототип | Новая реализация |
|---|---|
| `POST /graphql` | `POST /proxy` (алиас `/graphql` сохранён) |
| `GET /api/schema/graph` | `GET /api/schema` (типы + рёбра) |
| `GET /api/coverage/summary` | `GET /api/coverage?include=summary` |
| `GET /api/coverage/fields` | `GET /api/coverage` → `fields[]` |
| `GET /api/coverage/hot` | `GET /api/coverage` → `topFields` |
| `GET /api/coverage/field/{t}/{f}/queries` | `GET /api/executions?q=...` + drill-down |
| `GET /api/history` | `GET /api/executions` |
| `GET /api/runs` | `GET /api/runs` |
| `POST /api/runs/new` | `POST /api/runs` |
| `POST /api/runs/{id}/activate` | фильтр `?run=` в UI/API |
| `GET /api/diff?a=&b=` | `GET /api/coverage/compare?base=&head=` |
| `GET /api/export?fmt=csv` | `GET /api/coverage/export?format=csv&what=fields` |
| `GET /api/timeline` | `GET /api/coverage/timeline` |
| `POST /api/demo` | `POST /api/demo/seed` (DEMO_MODE) |
| `/api/ws/coverage` | пока нет; live-обновления можно добавить (SSE/WS) |
| `/api/selftest` | `GET /healthz` + `npm test` |
