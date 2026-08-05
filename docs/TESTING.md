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
