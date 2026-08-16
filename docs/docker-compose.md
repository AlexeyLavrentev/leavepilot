# Установка и запуск через Docker Compose

Это основной сценарий для:

- пилотного запуска внутри компании;
- внутреннего сервера;
- окружения, где сразу нужны `MySQL` и `Redis`;
- развёртывания, близкого к production.

Для переноса копии действующей установки в изолированный параллельный пилот
используйте [workplace-pilot-runbook.md](workplace-pilot-runbook.md).

## Что делает compose-конфигурация

`docker-compose.yml` поднимает:

- `db` — `MySQL 8`
- `redis` — `Redis 7`
- `app` — приложение LeavePilot

Контейнер приложения получает:

- `MySQL` как основную базу;
- `Redis` как хранилище сессий;
- конфиг из `config/app.redis.json`.

## Подготовка перед первым запуском

### 1. Создайте `.env`

```bash
cp .env.example .env
```

### 2. Обязательно поменяйте секреты и пароли

Минимально замените:

- `SESSION_SECRET`
- `CRYPTO_SECRET`
- `MYSQL_PASSWORD`
- `MYSQL_ROOT_PASSWORD`

### 3. При необходимости отредактируйте `config/app.redis.json`

Чаще всего меняют:

- `application_domain`
- `default_language`
- `supported_languages`
- `send_emails`
- `email_transporter`
- `allow_create_new_accounts`

Важно: при compose-запуске именно `config/app.redis.json` фактически становится рабочим `config/app.json` внутри контейнера.

## Как создается первый администратор

По умолчанию в compose-конфиге самостоятельная регистрация отключена:

```json
"allow_create_new_accounts": false
```

Поэтому из коробки страница `/register/` не подойдет для первого входа.

Для первичного развёртывания проще всего сделать так:

1. временно поставьте `allow_create_new_accounts` в `true` в `config/app.redis.json`;
2. поднимите сервисы;
3. откройте `/register/`;
4. зарегистрируйте первую компанию;
5. первый зарегистрированный пользователь автоматически станет администратором;
6. верните `allow_create_new_accounts` в `false`;
7. перезапустите контейнер приложения:

```bash
docker compose restart app
```

Если используется Premium SSO и вы хотите полностью избежать публичной
регистрации, можно оставить `false` и заводить пользователей через заранее
подготовленную схему администрирования или auto-provisioning.

## Обычный запуск

### 1. Соберите и поднимите контейнеры

```bash
docker compose up --build -d
```

## Commercial запуск с private premium module

Для commercial-сборки используйте override `docker-compose.commercial.yml`.
Он копирует private premium module в image через Docker BuildKit named context
и включает `TIMEOFF_PREMIUM_MODULE=/opt/timeoff-premium`.

Пример:

```bash
TIMEOFF_PREMIUM_MODULE_HOST_PATH=/path/to/timeoff-premium \
TIMEOFF_LICENSE=PASTE_BASE64_LICENSE_HERE \
TIMEOFF_LICENSE_PUBLIC_KEY=PASTE_PUBLIC_KEY_WITH_ESCAPED_NEWLINES_HERE \
docker compose -f docker-compose.yml -f docker-compose.commercial.yml up --build -d
```

Для локальной разработки premium-функций можно использовать volume override:

```bash
TIMEOFF_PREMIUM_MODULE_HOST_PATH=/path/to/timeoff-premium \
docker compose -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.premium-dev.yml up --build
```

`docker-compose.premium-dev.yml` принудительно задаёт `NODE_ENV=development`.
Флаги `FEATURE_*` в production и staging игнорируются.

Подробная схема community/commercial image описана в
`docs/community-commercial-builds.md`.

### 2. Примените миграции

```bash
docker compose run --rm app npm run db-update
```

### 3. Настройте ежедневные reminder-уведомления

Если в отделах включены напоминания перед отпуском, можно включить встроенный scheduler приложения через `.env`:

```env
LEAVE_REMINDER_SCHEDULER_ENABLED=true
LEAVE_REMINDER_SCHEDULER_TIME=09:00
LEAVE_REMINDER_SCHEDULER_TIMEZONE=UTC
```

После этого достаточно пересоздать контейнер `app`:

```bash
docker compose up -d --build app
```

Ручная команда остаётся доступной для проверки и аварийного запуска:

```bash
docker compose run --rm app npm run send-upcoming-leave-reminders
```

Она безопасна для повторного запуска и не должна отправлять дубли по уже обработанным отпускам.

### 4. Настройте scheduler внешних коннекторов Premium

Scheduler отключён по умолчанию. Включите его только после настройки и проверки
коннекторов в административном интерфейсе:

```env
EXTERNAL_CONNECTORS_SCHEDULER_ENABLED=true
EXTERNAL_CONNECTORS_SCHEDULER_TIME=08:00
EXTERNAL_CONNECTORS_SCHEDULER_TIMEZONE=UTC
```

Для внутренней Jira Data Center оператор может явно разрешить точные имена
хостов или IP-адреса (без схемы и порта):

```env
JIRA_DC_PRIVATE_HOST_ALLOWLIST=jira.internal.example,10.20.30.40
```

Generic Webhook остаётся public-only. Loopback, link-local и metadata адреса не
разрешаются даже через allowlist.

### 5. Откройте приложение

По умолчанию:

```text
http://localhost:3000
```

Если в `.env` вы поменяли `APP_PORT`, используйте свой порт.

## Что можно менять в `.env`

### База данных

- `DB_DIALECT`
- `DB_HOST`
- `DB_PORT`
- `DB_NAME`
- `DB_USER`
- `DB_PASSWORD`
- `DB_LOGGING`

### Настройки MySQL-контейнера

- `MYSQL_DATABASE`
- `MYSQL_USER`
- `MYSQL_PASSWORD`
- `MYSQL_ROOT_PASSWORD`

### Секреты приложения

- `SESSION_SECRET`
- `CRYPTO_SECRET`

### Параметры cookie и reverse proxy

- `TRUST_PROXY`
- `SESSION_COOKIE_SECURE`
- `SESSION_COOKIE_SAME_SITE`
- `SESSION_COOKIE_MAX_AGE_MS`

### Прочее

- `APP_PORT`
- `RUN_DB_MIGRATIONS`
- `LEAVE_REMINDER_SCHEDULER_ENABLED`
- `LEAVE_REMINDER_SCHEDULER_TIME`
- `LEAVE_REMINDER_SCHEDULER_TIMEZONE`
- `EXTERNAL_CONNECTORS_SCHEDULER_ENABLED`
- `EXTERNAL_CONNECTORS_SCHEDULER_TIME`
- `EXTERNAL_CONNECTORS_SCHEDULER_TIMEZONE`
- `JIRA_DC_PRIVATE_HOST_ALLOWLIST`

## Когда выключать `RUN_DB_MIGRATIONS`

Из коробки контейнер приложения сам применяет миграции при старте:
`docker-compose.yml` подставляет `${RUN_DB_MIGRATIONS:-true}`, а
`.env.example` задаёт `RUN_DB_MIGRATIONS=true`. Эффективное значение по
умолчанию — `true`: после `docker compose up --build -d` база сразу
получает актуальную схему, отдельных команд не нужно.

Отключают автозапуск обычно в одном случае: контролируемые выкладки, где
схему базы меняют только вручную и в согласованное окно. Для этого
поставьте в `.env` для `RUN_DB_MIGRATIONS` значение `false` — и
применяйте миграции явной командой:

```bash
docker compose run --rm app npm run db-update
```

## Как проверить, что всё поднялось

### Статус контейнеров

```bash
docker compose ps
```

Ожидаемо:

- `db` — healthy
- `redis` — healthy
- `app` — running или healthy

### Логи приложения

```bash
docker compose logs app
```

### Логи MySQL

```bash
docker compose logs db
```

### Логи Redis

```bash
docker compose logs redis
```

## Как проверить MySQL

### Проверка из MySQL-контейнера

```bash
docker compose exec db mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "SHOW DATABASES;"
```

### Проверка из приложения

```bash
docker compose exec app node -e "const db=require('./lib/model/db'); console.log({dialect: db.sequelize.getDialect(), host: db.sequelize.config.host, database: db.sequelize.config.database}); db.sequelize.close();"
```

Ожидаемо:

- `dialect: 'mysql'`
- `host: 'db'`

## Как проверить Redis

### Базовая проверка

Сервис `redis` в compose — это Engram (RESP2-совместимый движок), в его
образе нет `redis-cli`. Проверка выполняется из контейнера приложения
тем же клиентом, которым пользуется само приложение:

```bash
docker compose exec app node -e "const redis=require('redis'); const c=redis.createClient({url: 'redis://redis:6379', RESP: 2}); c.connect().then(() => c.ping()).then(r => { console.log(r); c.quit(); }).catch(e => { console.error(e.message); process.exit(1); });"
```

Ответ должен быть:

```text
PONG
```

### Проверка сессий

1. Войдите в приложение через браузер.
2. Выполните:

```bash
docker compose exec app node -e "const redis=require('redis'); const c=redis.createClient({url: 'redis://redis:6379', RESP: 2}); c.connect().then(() => c.keys('sess:*')).then(r => { console.log(r.join('\n')); c.quit(); }).catch(e => { console.error(e.message); process.exit(1); });"
```

Если ключи есть, сессии пишутся в Redis.

## Корпоративный запуск за reverse proxy

Если приложение публикуется не напрямую, а через `nginx`, `traefik` или `caddy`, обычно ставят:

```text
TRUST_PROXY=1
SESSION_COOKIE_SECURE=true
SESSION_COOKIE_SAME_SITE=lax
```

Также в `config/app.redis.json` нужно выставить корректный внешний адрес:

```json
"application_domain": "https://timeoff.example.com"
```

Если внешний URL и `application_domain` не совпадают, часто ломаются:

- SSO callback;
- корректная выдача secure-cookie;
- редиректы.

## Docker Compose для разработки

Если нужна разработка в контейнере с примонтированным проектом:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

Этот вариант:

- использует dev-target образа;
- монтирует код внутрь контейнера;
- пересобирает CSS;
- запускает приложение в `watch`-режиме.

## Как остановить и удалить окружение

### Просто остановить

```bash
docker compose down
```

### Остановить и удалить тома

```bash
docker compose down -v
```

Это удалит данные MySQL и Redis внутри docker volumes.

Используйте `-v` только если готовы потерять данные контейнеров.
# Диагностика для поддержки

Снимок состояния формируется локально и никуда не отправляется автоматически:

```bash
docker compose exec app npm run diagnostics > leavepilot-diagnostics.json
```

Соберите ограниченный интервал логов вокруг ошибки:

```bash
docker compose logs --since 30m --timestamps app > leavepilot-app.log
```

Каждый HTTP-ответ содержит `X-Request-Id`. Для поиска всей цепочки конкретного запроса:

```bash
docker compose logs --since 30m app | grep 'REQUEST_ID_FROM_RESPONSE'
```

Передавайте поддержке снимок, небольшой интервал логов, время ошибки и request ID. Снимок исключает секреты и пользовательские записи; передача всегда выполняется вручную.
