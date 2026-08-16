# LeavePilot

Source-available система для управления отпусками, больничными, отгулами и другими отсутствиями сотрудников.

Проект можно:

- быстро поднять локально для знакомства и тестирования;
- запустить как внутренний сервис компании;
- развернуть с `MySQL` и `Redis` через `docker compose`;
- подключить LDAP-аутентификацию;
- в Premium — подключить OIDC/SAML SSO и дополнительные модули.

## Что умеет приложение

- календарный и табличный просмотр отсутствий;
- роли сотрудника, руководителя и администратора;
- согласование отпусков;
- разные типы отсутствий;
- экспорт в CSV;
- интеграция с календарями;
- локализация интерфейса;
- LDAP-аутентификация.

## Community и Premium

Community остаётся полноценным приложением для управления отсутствиями. Premium
добавляет корпоративные функции и требует private premium module и подписанную
лицензию в production.

| Возможность | Community | Premium |
|---|---:|---:|
| Базовое управление отсутствиями | да | да |
| Роли сотрудника, руководителя и администратора | да | да |
| Согласование заявок | да | да |
| CSV-экспорт и отчёты | да | да |
| LDAP | да | да |
| Напоминания перед отпуском | да | да |
| OIDC/SAML SSO | нет | да |
| Группы сотрудников | нет | да |
| Рабочие календари | нет | да |
| Integration API | нет | да |
| Баланс времени | нет | да |
| Планирование отпусков | нет | да |

Режимы запуска и правила лицензирования описаны в
[docs/community-commercial-builds.md](docs/community-commercial-builds.md).

## Какой способ установки выбрать

| Сценарий | Рекомендуемый способ |
|---|---|
| Просто посмотреть и протестировать приложение на одном ПК | `npm` + `SQLite` |
| Разработка без Docker | `npm` + `SQLite` или внешний `MySQL` |
| Корпоративный пилот / внутренний сервер | `docker compose` |
| Нужны `MySQL` и `Redis` "из коробки" | `docker compose` |

Если нужна самая простая установка для обычного пользователя, начинайте с `npm` + `SQLite`.

Если нужна конфигурация, похожая на рабочую корпоративную среду, используйте `docker compose`.

## Что понадобится заранее

### Для установки через npm

- `Node.js 22` (диапазон из `package.json`: `>=22.12.0 <23`)
- `npm`

### Для установки через Docker

- `Docker`
- `Docker Compose` plugin (`docker compose`)

## Что нужно проверить и при необходимости отредактировать до первого запуска

### 1. Файл `.env`

Для `docker compose` это обязательный шаг.

Скопируйте шаблон:

```bash
cp .env.example .env
```

Минимум, что нужно заменить:

- `SESSION_SECRET`
- `CRYPTO_SECRET`
- `MYSQL_PASSWORD`
- `MYSQL_ROOT_PASSWORD`
- `SESSION_COOKIE_SECURE` — поставьте `true`, если TLS терминируется прокси
  перед приложением. По умолчанию `false`, и тогда cookie сессии уходит без
  атрибута `Secure`: любой запрос по обычному HTTP к этому домену унесёт
  идентификатор сессии открытым текстом. Приложение предупреждает об этом при
  старте строкой `security_posture:`, если `TRUST_PROXY` включён, а флаг — нет.

Если нужно, также меняют:

- `APP_PORT`
- `DB_NAME`
- `DB_USER`
- `DB_PASSWORD`
- `TRUST_PROXY`
- `SESSION_COOKIE_SAME_SITE`

### 2. Файл `config/app.json`

Нужно редактировать, если вы запускаете приложение напрямую через `npm`.

Чаще всего меняют:

- `application_domain` — адрес приложения, который видят пользователи;
- `default_language` и `supported_languages`;
- `allow_create_new_accounts` — разрешать ли самостоятельную регистрацию;
- `send_emails` и `email_transporter` — если хотите реальные почтовые уведомления;
- `sessionStore.useRedis` и `sessionStore.redisConnectionConfiguration` — если локальный запуск через `npm` должен использовать `Redis`.

### 3. Файл `config/app.redis.json`

Нужно редактировать, если вы запускаете приложение через `docker compose`.

Именно этот файл монтируется в контейнер как основной `config/app.json`.

Обычно меняют:

- `application_domain`;
- `default_language` и `supported_languages`;
- `send_emails` и `email_transporter`;
- `allow_create_new_accounts` — по умолчанию уже `false`;
- `sessionStore.redisConnectionConfiguration`, если Redis будет не в контейнере `redis`.

## Быстрый старт №1: npm + SQLite

Это самый простой способ попробовать приложение локально.

### Шаг 1. Установите зависимости

```bash
npm install
```

### Шаг 2. Примените миграции

```bash
npm run db-update
```

### Шаг 3. Запустите приложение

```bash
npm start
```

### Ежедневные напоминания перед отпуском

После включения флага reminder-уведомлений в настройках отдела можно запустить рассылку вручную:

```bash
npm run send-upcoming-leave-reminders
```

По умолчанию команда ищет утверждённые отпуска, которые начнутся через 14 дней, и рассылает письма без дублей.

Для автоматического запуска внутри приложения задайте:

```bash
LEAVE_REMINDER_SCHEDULER_ENABLED=true
LEAVE_REMINDER_SCHEDULER_TIME=09:00
LEAVE_REMINDER_SCHEDULER_TIMEZONE=UTC
```

Если scheduler включён, отдельный cron для reminder-уведомлений не требуется.

### Внешние коннекторы Premium

Встроенный scheduler внешних коннекторов по умолчанию выключен. Для ежедневной
синхронизации задайте:

```bash
EXTERNAL_CONNECTORS_SCHEDULER_ENABLED=true
EXTERNAL_CONNECTORS_SCHEDULER_TIME=08:00
EXTERNAL_CONNECTORS_SCHEDULER_TIMEZONE=Asia/Yekaterinburg
```

Jira Data Center часто доступна только во внутренней сети. Такие адреса
запрещены по умолчанию. Оператор развёртывания может разрешить точные имена
хостов или IP-адреса через запятую, например:

```bash
JIRA_DC_PRIVATE_HOST_ALLOWLIST=jira.internal.example,10.20.30.40
```

Не добавляйте в allowlist loopback, metadata или link-local адреса: они всегда
блокируются. Настройка доступна только оператору контейнера и не управляется из
интерфейса компании.

### Шаг 4. Откройте приложение

Откройте в браузере:

```text
http://localhost:3000
```

### Что происходит в этом режиме

- по умолчанию используется `SQLite`;
- база лежит в файле `db.development.sqlite`;
- сессии по умолчанию хранятся в базе, а не в `Redis`;
- секреты для `development` подставляются автоматически, если вы не задали их вручную.

### Как появляется первый администратор

Самый простой способ — команда `create-admin`:

```bash
npm run create-admin -- --email admin@example.com --company "Моя компания"
```

Команда создаст компанию и администратора. Если не передать `--password`,
сгенерируется случайный пароль и будет показан один раз в терминале.

Дополнительные опции: `--country RU|KZ|...`, `--timezone Europe/Moscow`,
`--name`, `--lastname`.

Альтернатива: в этом режиме самостоятельная регистрация включена по умолчанию,
поэтому можно открыть `/register/` и зарегистрировать компанию — первый
пользователь автоматически станет администратором.

Подробная инструкция: [docs/install-local-npm.md](docs/install-local-npm.md)

### Демо: заполненный продукт одной командой

Самый быстрый способ увидеть работающий продукт — демо-стенд на той же
Docker-поставке, которую получает клиент:

```bash
npm run demo
```

Команда поднимет локальный стенд и наполнит его демо-данными: компания
«Демо компания», 4 отдела, 12 сотрудников и отпуска — уже одобренные и
ожидающие согласования.

Секреты `SESSION_SECRET` и `CRYPTO_SECRET` стенд получает демонстрационными
значениями по умолчанию — отдельная настройка не нужна. Для реального
развёртывания задайте собственные секреты (раздел «Файл `.env`» выше).

Откройте в браузере:

```text
http://localhost:3001
```

и войдите фиксированными демо-данными:

```text
Логин:  demo-admin@leavepilot.local
Пароль: DemoLeavePilot1!
```

Убрать демо-стенд вместе со всеми его данными:

```bash
docker compose -f docker-compose.demo.yml down -v
```

Вот как выглядит продукт с демо-данными:

![Календарь команды: отпуска сотрудников по отделам](docs/screenshots/calendar.png)

![Список заявок: отпуска, ожидающие согласования](docs/screenshots/requests.png)

Скриншоты снимаются скриптом `npm run screenshots` — та же команда
обновит их перед релизом.

Если Docker-стенд не нужен, те же демо-данные можно налить в уже
развёрнутую девелоперскую установку:

```bash
npm run seed-demo
```

Команда создаст ту же демо-компанию. Логин и одноразовый пароль
администратора будут показаны в терминале. Свои значения можно передать через
`--email`, `--password`, `--company`, `--country`.

## Быстрый старт №2: npm + внешний MySQL и Redis

Этот режим подходит, если Docker не нужен, но вы хотите работать не с `SQLite`, а с реальными сервисами.

### Перед запуском

1. Поднимите свой `MySQL`.
2. Поднимите свой `Redis`.
3. Отредактируйте `config/app.json`:
   - включите `sessionStore.useRedis: true`;
   - пропишите адрес `Redis`.
4. Задайте переменные окружения для БД.

Пример:

```bash
export DB_DIALECT=mysql
export DB_HOST=127.0.0.1
export DB_PORT=3306
export DB_NAME=timeoff
export DB_USER=timeoff
export DB_PASSWORD=strong_password
export SESSION_SECRET=replace-me
export CRYPTO_SECRET=replace-me
```

### Дальше

```bash
npm install
npm run db-update
npm start
```

## Быстрый старт №3: Docker Compose

Это рекомендуемый способ для пилота, внутреннего сервера и "почти production" запуска.

### Шаг 1. Подготовьте `.env`

```bash
cp .env.example .env
```

Замените секреты и пароли.

### Шаг 2. При необходимости отредактируйте `config/app.redis.json`

Обычно заранее меняют:

- `application_domain`;
- email-настройки;
- языки интерфейса;
- политику регистрации пользователей.

### Шаг 3. Поднимите сервисы

```bash
docker compose up --build -d
```

### Шаг 4. Примените миграции

```bash
docker compose run --rm app npm run db-update
```

### Шаг 5. Откройте приложение

```text
http://localhost:3000
```

Или `http://localhost:<APP_PORT>`, если вы меняли порт в `.env`.

### Как создать первого администратора в compose-сценарии

Регистрацию через веб включать не нужно — создайте администратора командой
внутри контейнера приложения:

```bash
docker compose exec app npm run create-admin -- --email admin@example.com --company "Моя компания"
```

Команда создаст компанию и администратора и покажет сгенерированный пароль
один раз в терминале (или передайте свой через `--password`).

`allow_create_new_accounts` при этом остаётся `false` — публичная регистрация
не открывается вовсе.

Подробная инструкция: [docs/docker-compose.md](docs/docker-compose.md)

## Как проверить, что приложение вообще работает

### Быстрая ручная проверка

1. Открывается страница входа.
2. Нет ошибки `500 Internal Server Error`.
3. После входа доступны календарь и настройки.

### Проверка контейнеров

```bash
docker compose ps
```

Ожидаемый результат: `app`, `db`, `redis` находятся в состоянии `running` или `healthy`.

### Проверка HTTP-ответа

```bash
curl -I http://localhost:3000
```

Если приложение отвечает, вы увидите HTTP-статус и заголовки.

## Как проверить, что используется MySQL, а не SQLite

### В Docker Compose

Проверьте диалект и параметры подключения изнутри контейнера приложения:

```bash
docker compose exec app node -e "const db=require('./lib/model/db'); console.log({dialect: db.sequelize.getDialect(), host: db.sequelize.config.host, database: db.sequelize.config.database}); db.sequelize.close();"
```

Ожидаемый результат:

- `dialect: 'mysql'`
- `host: 'db'` или ваш MySQL-хост

Дополнительно можно проверить сам MySQL:

```bash
docker compose exec db mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "SHOW DATABASES;"
```

### В локальном запуске через npm

```bash
node -e "const db=require('./lib/model/db'); console.log({dialect: db.sequelize.getDialect(), host: db.sequelize.config.host, storage: db.sequelize.options.storage}); db.sequelize.close();"
```

Признаки:

- если `dialect` равен `mysql`, приложение работает с `MySQL`;
- если `dialect` равен `sqlite`, приложение работает с `SQLite`;
- у `SQLite` обычно будет `storage: './db.development.sqlite'`.

## Как проверить, что Redis подключен и работает нормально

### Проверка самого Redis

Сервис `redis` в compose — это Engram (RESP2-совместимый движок), в его
образе нет `redis-cli`. Проверка выполняется из контейнера приложения
тем же клиентом, которым пользуется само приложение:

```bash
docker compose exec app node -e "const redis=require('redis'); const c=redis.createClient({url: 'redis://redis:6379', RESP: 2}); c.connect().then(() => c.ping()).then(r => { console.log(r); c.quit(); }).catch(e => { console.error(e.message); process.exit(1); });"
```

Ожидаемый ответ:

```text
PONG
```

### Проверка сессий в Redis

1. Войдите в приложение в браузере.
2. Выполните:

```bash
docker compose exec app node -e "const redis=require('redis'); const c=redis.createClient({url: 'redis://redis:6379', RESP: 2}); c.connect().then(() => c.keys('sess:*')).then(r => { console.log(r.join('\n')); c.quit(); }).catch(e => { console.error(e.message); process.exit(1); });"
```

Если ключи появились, сессии пишутся в Redis.

### Проверка из логов приложения

В логах приложения должна появляться строка:

```text
Connected to redis successfully
```

Посмотреть логи:

```bash
docker compose logs app
```

### Важно

При обычном локальном запуске через `npm` Redis по умолчанию не используется, потому что в `config/app.json` стоит:

```json
"useRedis": false
```

Если вам нужен Redis в режиме `npm`, это нужно включить вручную.

## Как протестировать приложение

### 1. Быстрый ручной smoke test

- открыть страницу входа;
- войти под администратором;
- создать сотрудника;
- создать тип отсутствия;
- завести заявку на отпуск;
- убедиться, что календарь и список отображаются.

### 2. Автотесты

```bash
npm test
```

В проекте часть тестов опирается на браузерный стек. Если хотите прогонять сценарии через Chrome, смотрите раздел в:

[docs/verification-and-troubleshooting.md](docs/verification-and-troubleshooting.md)

## Обновление существующей установки

### Для npm-установки

```bash
git fetch
git pull
npm install
npm run db-update
npm start
```

### Для Docker Compose

```bash
git fetch
git pull
docker compose up --build -d
docker compose run --rm app npm run db-update
```

Миграции пропускать нельзя: новая версия кода может ожидать уже изменённую схему БД.

## Готовый Community Docker-образ

Multi-platform образ публикуется в GitHub Container Registry:

```text
ghcr.io/alexeylavrentev/leavepilot-community
```

Для production фиксируйте полную версию образа. Инструкция и отдельный Compose
файл: [docs/container-images.md](docs/container-images.md).

## Шифрование секретов в БД (at rest)

Секреты, которые приложение хранит в базе, шифруются перед записью с помощью
AES-256-GCM (authenticated encryption). Сейчас это **OIDC client secret** внутри
`Companies.sso_auth_config`.

Формат хранения (версионированный): `enc:v1:aes-256-gcm:<iv>:<tag>:<ciphertext>`
(части в base64).

### Ключ шифрования

Ключ выводится (SHA-256, с доменным разделением) из:

- `TIMEOFF_SECRET_KEY` — опциональная выделенная переменная; если не задана,
- используется общий `CRYPTO_SECRET`.

`CRYPTO_SECRET` уже является обязательным в production стабильным секретом
приложения, поэтому новой обязательной переменной не вводится. Доменное
разделение делает этот ключ независимым от других применений `CRYPTO_SECRET`
(например, хеширования паролей).

### Обратная совместимость и миграция

- Существующие значения в открытом виде продолжают читаться; при следующем
  сохранении они перезаписываются в зашифрованном виде.
- Миграция `20260627130000-encrypt-sso-client-secret.js` шифрует уже сохранённые
  plaintext-секреты. При отсутствующем или неверном ключе она завершается с
  ошибкой, поэтому остаётся доступной для повторного запуска. Значение секрета
  не логируется.
- Для установок, где прежняя версия миграции уже отмечена применённой, доступна
  независимая повторяемая команда. Сначала выполните безопасный аудит, затем
  примените изменения:

  ```bash
  npm run sso-secret-backfill -- --dry-run
  npm run sso-secret-backfill -- --apply
  ```

  Команда выводит только суммарные количества категорий. Повторный `--apply`
  ничего не меняет. Строки с повреждённым JSON не перезаписываются.
- Поле client secret в UI больше **не предзаполняется**: пустое поле при
  сохранении означает «оставить текущий секрет», а не «очистить».

### Эксплуатационные предупреждения

- **Потеря ключа делает зашифрованные секреты невосстановимыми.** Относитесь к
  `CRYPTO_SECRET` / `TIMEOFF_SECRET_KEY` как к критичному для бэкапа секрету.
- **Бэкап/восстановление:** дамп БД пригоден только вместе с тем же ключом.
  Восстановление БД в окружение с другим ключом не сможет расшифровать секреты.
- **Ротация ключа не реализована.** Смена ключа инвалидирует ранее
  зашифрованные секреты (их придётся ввести заново).

## Частые вопросы

### Можно ли сначала работать на SQLite, а потом перейти на MySQL?

Да, но это не автоматическая миграция данных. Нужно отдельно переносить данные и отдельно проверять схему.

### Нужно ли редактировать `.env` при запуске через npm?

Нет, не обязательно. Для `development` приложение использует безопасные fallback-секреты. Но для реальной рабочей установки лучше задавать свои значения.

### Какой порт используется?

- локальный `npm start`: `3000`, если не задан `PORT`;
- `docker compose`: контейнер слушает `3000`, наружу публикуется `${APP_PORT:-3000}`.

### Почему через Docker используется `config/app.redis.json`, а не `config/app.json`?

Потому что compose специально монтирует конфиг с включенным Redis-хранилищем сессий.

### Где смотреть инструкции по SSO?

Документ здесь:

[docs/sso-keycloak.md](docs/sso-keycloak.md)

## Карта документации

- [Локальная установка через npm](docs/install-local-npm.md)
- [Установка и запуск через Docker Compose](docs/docker-compose.md)
- [Проверка работы, диагностика и типовые проблемы](docs/verification-and-troubleshooting.md)
- [FAQ для пользователей и администраторов](docs/faq.md)
- [Redis как хранилище сессий](docs/SessionStoreInRedis.md)
- [SSO через Keycloak](docs/sso-keycloak.md)
- [Архитектура лицензирования](docs/licensing-architecture.md)
- [Операции с лицензиями](docs/license-operations.md)
- [Проектирование License Portal MVP](docs/license-portal-design.md)
- [Чеклист оператора: бэкап и восстановление](docs/operator-backup-checklist.md)
- [Компрометация ключа подписи лицензий](docs/license-key-compromise.md)

## Лицензирование и использование

### Community Edition

LeavePilot Community Edition распространяется по лицензии Elastic License 2.0
(SPDX: `Elastic-2.0`).

Вы можете:
- разворачивать систему у себя, в том числе для коммерческого использования внутри своей организации;
- модифицировать исходный код;
- распространять свои модификации.

Вы не можете предоставлять систему третьим лицам как hosted or managed service,
которая даёт пользователям доступ к существенной части возможностей системы.

Полный текст лицензии — [LICENSE.md](LICENSE.md). Разбор границы «hosted or
managed service» с примерами по типовым сценариям —
[docs/licensing-faq.md](docs/licensing-faq.md). История лицензирования и
атрибуция апстрима — в файле NOTICE.

### Premium Edition

LeavePilot Premium — это проприетарный модуль, требующий лицензии.
Premium Edition включает:
- OIDC/SAML SSO;
- группы сотрудников;
- рабочие календари;
- Integration API;
- баланс времени;
- планирование отпусков.

Для получения лицензии и условий использования см.:
- [EULA](docs/EULA.md) — лицензионное соглашение
- [Privacy Policy](docs/PRIVACY.md) — политика конфиденциальности

## Обратная связь

Если вы нашли ошибку в коде или документации, создайте issue в репозитории или обновите инструкции под свою рабочую схему развёртывания.
