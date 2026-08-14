# Тестовое окружение LeavePilot

Данное окружение предназначено для полноценного тестирования всех функций LeavePilot, включая SSO аутентификацию и email отправку.

## Быстрый старт

```bash
# Запуск тестового окружения
./scripts/start-test-env.sh

# Остановка тестового окружения
./scripts/stop-test-env.sh
```

## Компоненты

| Сервис | URL | Логин | Описание |
|--------|-----|-------|----------|
| **LeavePilot** | http://localhost:3000 | - | Основное приложение |
| **Keycloak** | http://localhost:8080 | admin/admin | SSO сервер |
| **MailPit** | http://localhost:8025 | - | SMTP сервер + Web UI |
| **PostgreSQL** | localhost:5432 | timeoff/timeoff_password | База данных |
| **Redis** | localhost:6379 | - | Хранилище сессий |

## Тестовые пользователи

### Keycloak
- **Username:** `testuser`
- **Password:** `Test123456!`
- **Email:** `testuser@leavepilot.test`
- **Realm:** `leavepilot`

### LeavePilot (локальный)
- **Email:** `testuser@example.com`
- **Password:** `Test123456`

## Тестирование функций

### 1. SSO Аутентификация (OIDC)

1. Перейдите на http://localhost:3000
2. Кликните "Login with SSO"
3. Войдите через Keycloak (testuser / Test123456!)
4. Проверьте успешный вход в LeavePilot

### 2. Email отправка

1. Создайте запрос на отпуск
2. Проверьте email в MailPit: http://localhost:8025
3. Откройте email и проверьте содержимое

### 3. Отправка напоминаний

1. Настройте напоминания в настройках компании
2. Дождитесь отправки
3. Проверьте email в MailPit

## Конфигурация

### Переменные окружения (.env.testing)

```bash
# База данных
DB_DIALECT=postgres
DB_HOST=localhost
DB_PORT=5432
DB_NAME=timeoff
DB_USER=timeoff
DB_PASSWORD=timeoff_password

# Email (MailPit)
EMAIL_SMTP_HOST=localhost
EMAIL_SMTP_PORT=1025
EMAIL_SMTP_USER=test
EMAIL_SMTP_PASSWORD=test

# Keycloak SSO
SSO_AUTH_ENABLED=true
SSO_AUTH_PROVIDER=oidc
SSO_AUTH_CONFIG={"issuer":"http://localhost:8080/realms/leavepilot",...}
```

### Docker Compose

Файл: `docker-compose.testing.yml`

```yaml
services:
  postgres:    # База данных
  keycloak:    # SSO сервер
  mailpit:     # Email тестирование
  redis:       # Сессии
```

## Автоматические тесты

### Запуск всех тестов

```bash
# С запущенным тестовым окружением
npm test

# Или с автоматическим запуском окружения
./scripts/run-all-tests.sh
```

### Тестирование отдельных функций

```bash
# SSO тесты
npm test -- tests/sso/

# Email тесты
npm test -- tests/email/

# API тесты
npm test -- tests/api/
```

### Покрытие кода

```bash
# Community/core unit-suite и coverage gate
NODE_ENV=test DB_DIALECT=sqlite DB_STORAGE=/tmp/coverage.sqlite \
  npm run test:coverage

# Premium: запускать из каталога timeoff-premium рядом с timeoff
npm run test:coverage
```

Пороги находятся в `.nycrc.json` каждого репозитория и фиксируют текущий
baseline. CI не позволяет снизить statements, branches, functions или lines.
После добавления тестов пороги следует поднимать до нового фактического
значения. Миграции исключены: они проверяются отдельными migration smoke tests.

## Устранение проблем

### Keycloak не запускается

```bash
# Проверка логов
docker logs leavepilot-keycloak

# Перезапуск
docker restart leavepilot-keycloak
```

### Email не отправляются

```bash
# Проверка MailPit
curl http://localhost:8025/api/v1/messages

# Проверка SMTP
telnet localhost 1025
```

### База данных не доступна

```bash
# Проверка PostgreSQL
docker exec -it leavepilot-postgres psql -U timeoff -d timeoff

# Пересоздание БД
docker compose -f docker-compose.testing.yml down -v
docker compose -f docker-compose.testing.yml up -d
```

## Дополнительные ресурсы

- [Keycloak Documentation](https://www.keycloak.org/documentation)
- [MailPit Documentation](https://github.com/axllent/mailpit)
- [LeavePilot Documentation](../README.md)

## Обновление

Для обновления тестового окружения:

```bash
# Остановка
./scripts/stop-test-env.sh

# Обновление контейнеров
docker pull quay.io/keycloak/keycloak:25.0
docker pull axllent/mailpit:latest

# Запуск
./scripts/start-test-env.sh
```

## Удаление

Для полного удаления данных:

```bash
./scripts/stop-test-env.sh
docker compose -f docker-compose.testing.yml down -v
docker volume prune
```

# Running the MySQL contour locally

The default test contour is SQLite and nothing below is needed for it: a
plain `npm test` keeps using a throwaway SQLite file. The MySQL contour
exists to reproduce, on a developer machine, what a dialect-sensitive defect
looks like before pushing — the same class of failure the CI MySQL jobs
catch.

## Start a disposable MySQL 8

```bash
docker run -d --name lp-test-mysql \
  -e MYSQL_ROOT_PASSWORD=rootpw \
  -e MYSQL_DATABASE=lp_test \
  -p 3306:3306 \
  mysql:8.0.45
```

It takes a moment to become ready; wait for it to answer before running
anything against it:

```bash
for i in $(seq 1 60); do
  if docker exec lp-test-mysql mysqladmin ping -h127.0.0.1 -uroot -prootpw >/dev/null 2>&1; then
    echo "MySQL ready (attempt $i)"
    break
  fi
  sleep 2
done
```

Remove it when finished: `docker rm -f lp-test-mysql`.

## Point the runner at it

```bash
TEST_DB_DIALECT=mysql \
DB_HOST=127.0.0.1 DB_PORT=3306 DB_NAME=lp_test DB_USER=root DB_PASSWORD=rootpw \
npm test
```

- `TEST_DB_DIALECT=mysql` is the runner knob: with it the runner's children
  get `DB_DIALECT=mysql`; with any other value — or unset — they get
  `DB_DIALECT=sqlite`, so the default contour is unchanged.
- The `DB_*` connection variables (`DB_HOST`, `DB_PORT`, `DB_NAME`,
  `DB_USER`, `DB_PASSWORD`) are ordinary passthrough environment variables;
  the runner does not enumerate or default them.
- `DB_STORAGE` stays the SQLite file path and is simply ignored under MySQL.

## Reproducing a CI-red dialect run before pushing

Run the same command the CI migration smoke job runs, against the disposable
server above:

```bash
TEST_DB_DIALECT=mysql \
DB_HOST=127.0.0.1 DB_PORT=3306 DB_NAME=lp_test DB_USER=root DB_PASSWORD=rootpw \
node bin/db_update.js
```

If a spec or a migration is red under MySQL while green under SQLite, that
is a dialect defect: fix it before pushing rather than after the CI job
finds it for you.
