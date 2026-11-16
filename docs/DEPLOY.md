# Деплой: GitHub → Render

## 1. Репозиторий на GitHub

```bash
git init -b main          # уже сделано в этом проекте
git add .
git commit -m "feat: GraphQL Coverage Proxy"
git remote add origin git@github.com:<owner>/<repo>.git
git push -u origin main
```

В репозитории уже есть:

- `render.yaml` — Blueprint для Render;
- `Dockerfile` — альтернативный способ запуска;
- `.github/workflows/ci.yml` — тесты + smoke на каждый push/PR;
- `package-lock.json` — для `npm ci`.

## 2. Blueprint в Render

1. Зайдите в [Render Dashboard](https://dashboard.render.com) → **New → Blueprint**.
2. Подключите GitHub и выберите репозиторий.
3. Render найдёт `render.yaml` и предложит сервис `graphql-coverage-proxy`.
4. Проверьте параметры:
   - **Runtime**: Node;
   - **Build**: `npm ci --omit=dev`;
   - **Start**: `npm start`;
   - **Health check**: `/healthz`;
   - **Plan**: Free (для демо) или Starter (для persistent disk).
5. Нажмите **Apply**.

Первый деплой занимает 1–2 минуты. В логах будет:

```
server.started {"url":"http://0.0.0.0:10000",...}
demo.seeded {"runs":4,"executions":42}
```

## 3. Переменные окружения

`render.yaml` уже задаёт безопасные значения. Что нужно заполнить вручную:

| Переменная | Обязательно | Назначение |
|---|---|---|
| `TARGET_GRAPHQL_URL` | да, если нужен прокси | целевой GraphQL endpoint |
| `TARGET_AUTH` / `SCHEMA_INTROSPECT_HEADERS` | если upstream требует токен | `{"authorization":"Bearer ..."}` |
| `PROXY_API_KEY` | для публичного сервиса | ключ доступа к `/proxy` |
| `ADMIN_TOKEN` | генерируется автоматически | ключ для загрузки схем/ingest |
| `SERVICES_JSON` | для нескольких сервисов | `{"shop":{"url":"..."},"crm":{"url":"..."}}` |
| `ALLOWED_TARGET_HOSTS` | при override | allowlist хостов |
| `ALLOW_TARGET_OVERRIDE` | по умолчанию `false` | разрешить `x-target-url` |
| `DEMO_MODE` | `true` по умолчанию | демо-данные на пустом диске |

`ADMIN_TOKEN` Render генерирует один раз. Скопируйте его из **Environment** и вставьте
в UI: иконка шестерёнки → **Admin token** (хранится только в localStorage браузера).

## 4. Проверка

```bash
curl https://<service>.onrender.com/healthz
# {"status":"ok",...}

open https://<service>.onrender.com
```

Если `TARGET_GRAPHQL_URL` не задан, нажмите **«Схема» → Introspection** и укажите URL:
сервис загрузит схему и начнёт принимать запросы на `/proxy`.

## 5. Persistent disk (рекомендуется для продакшена)

Free-план Render использует эфемерный `/tmp`: после рестарта/деплоя данные теряются
(демо-режим пересоздаст их, а реальные прогоны — нет).

1. Upgrade сервиса до платного плана.
2. **Settings → Disks → Add Disk**: name `gqlcov-data`, mount path `/var/data`, 1 GB.
3. В `render.yaml` замените `DATA_DIR=/tmp/gqlcov` на `DATA_DIR=/var/data`
   (или задайте переменную в дашборде).
4. Redeploy.

Либо запускайте с Docker-образом и volume:

```bash
docker build -t gqlcov .
docker run -p 3000:10000 -v gqlcov-data:/data -e DEMO_MODE=true gqlcov
```

## 6. Автодеплой и CI

- **Render autoDeploy** включён: пуш в `main` пересобирает сервис.
- **GitHub Actions** (`.github/workflows/ci.yml`) гоняет тесты и smoke на каждый push/PR.
- **Deploy hook** (опционально): Render → Settings → Deploy Hook, затем добавьте
  секрет `RENDER_DEPLOY_HOOK` в GitHub. Workflow вызовет его после зелёных тестов.

### GitLab CI

Готового шаблона нет, но есть два рабочих сценария.

**A. Тесты ходят через прокси** (ничего дополнительно не нужно):

```yaml
variables:
  GRAPHQL_URL: "https://<service>.onrender.com/proxy"
  GRAPHQL_PROXY_KEY: $PROXY_API_KEY   # если задан
  GRAPHQL_RUN_ID: $CI_PIPELINE_ID
  GRAPHQL_BRANCH: $CI_COMMIT_REF_NAME

test:
  image: node:22
  script:
    - npm ci
    - npm test
```

**B. Покрытие загружается после тестов** (без прокси), через ingest:

```yaml
upload-coverage:
  image: node:22
  needs: [test]
  script:
    - node scripts/collect-queries.mjs > queries.json   # ваш сборщик запросов
    - |
      curl -fsS -X POST "$COVERAGE_URL/api/ingest" \
        -H 'content-type: application/json' \
        -H "x-admin-token: $COVERAGE_ADMIN_TOKEN" \
        -d "{
          \"run\": {\"runId\": \"$CI_PIPELINE_ID\", \"branch\": \"$CI_COMMIT_REF_NAME\", \"team\": \"qa\", \"env\": \"staging\", \"build\": \"$CI_PIPELINE_ID\"},
          \"queries\": $(cat queries.json)
        }"
```

## 7. Бэкап и перенос состояния

```bash
curl -s -H "x-admin-token: $ADMIN_TOKEN" \
  https://<service>.onrender.com/api/state/export > state.json

curl -s -X POST -H "content-type: application/json" \
  -H "x-admin-token: $ADMIN_TOKEN" \
  --data-binary @state.json \
  https://<service>.onrender.com/api/state/import
```

Экспорт содержит схемы, прогоны и агрегаты покрытия (без журнала запросов — он объёмный).

## 8. Диагностика

| Симптом | Причина и решение |
|---|---|
| `502` при introspection | upstream требует авторизацию — задайте `SCHEMA_INTROSPECT_HEADERS` |
| `401` в UI при загрузке SDL | неверный/пустой Admin token — вставьте значение из Render |
| `403` на `/proxy` | включён `PROXY_API_KEY` — передайте `x-proxy-key` |
| `403` «приватные адреса запрещены» | локальный upstream при `ALLOW_PRIVATE_TARGETS=false` — включите для dev |
| Данные исчезли после рестарта | free-план, эфемерный диск — см. раздел 5 |
| Первый запрос долго (30–60 с) | free-план «засыпает»; это cold start Render |
| Покрытие не растёт | не задан `TARGET_GRAPHQL_URL` или запросы идут мимо `/proxy` |
| `413` | тело больше `MAX_BODY_MB` — увеличьте лимит |
