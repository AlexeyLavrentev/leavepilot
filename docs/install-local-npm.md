# Локальная установка через npm

Этот сценарий подходит, если вы хотите:

- быстро познакомиться с приложением;
- запустить его на одном компьютере;
- разрабатывать без Docker;
- сначала попробовать `SQLite`, а потом при необходимости перейти на `MySQL`.

## Вариант A. Самый простой запуск: npm + SQLite

## Что понадобится

- `Node.js 22` (диапазон из `package.json`: `>=22.12.0 <23`)
- `npm`

## Пошаговая установка

### 1. Установите зависимости

```bash
npm install
```

### 2. Примените миграции

```bash
npm run db-update
```

### 3. Запустите приложение

```bash
npm start
```

### 4. Откройте браузер

```text
http://localhost:3000
```

## Что будет использовано

- база: `SQLite`
- файл базы: `db.development.sqlite`
- сессии: в таблице `Sessions` в основной базе
- Redis: не используется

## Как создаются первая компания и первый администратор

При локальном сценарии через `npm` по умолчанию включена самостоятельная регистрация:

```json
"allow_create_new_accounts": true
```

Это значит:

1. откройте страницу `/register/`;
2. заполните данные компании и первого пользователя;
3. после регистрации этот пользователь автоматически становится администратором.

## Что можно отредактировать до запуска

### `config/app.json`

Обычно редактируют:

- `application_domain`
- `default_language`
- `supported_languages`
- `allow_create_new_accounts`
- `send_emails`
- `email_transporter`

Если хотите запускать через `npm`, но хранить сессии в `Redis`, включите:

```json
"sessionStore": {
  "useRedis": true,
  "redisConnectionConfiguration": {
    "host": "127.0.0.1",
    "port": 6379
  }
}
```

## Как убедиться, что реально используется SQLite

```bash
node -e "const db=require('./lib/model/db'); console.log({dialect: db.sequelize.getDialect(), storage: db.sequelize.options.storage}); db.sequelize.close();"
```

Ожидаемо:

- `dialect: 'sqlite'`
- `storage: './db.development.sqlite'`

## Вариант B. npm + внешний MySQL

Этот вариант нужен, если Docker не используется, но база должна быть именно `MySQL`.

## Что нужно дополнительно

- доступный сервер `MySQL`
- созданная база данных
- пользователь MySQL с правами на эту базу

## Какие переменные окружения задать

Пример для Linux/macOS:

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

После этого:

```bash
npm install
npm run db-update
npm start
```

## Как убедиться, что реально используется MySQL

```bash
node -e "const db=require('./lib/model/db'); console.log({dialect: db.sequelize.getDialect(), host: db.sequelize.config.host, database: db.sequelize.config.database}); db.sequelize.close();"
```

Ожидаемо:

- `dialect: 'mysql'`
- правильный `host`
- правильная `database`

## Вариант C. npm + внешний MySQL + Redis

Если вам нужна схема ближе к корпоративной:

1. Настройте MySQL, как в варианте B.
2. Поднимите Redis.
3. В `config/app.json` включите `sessionStore.useRedis`.
4. Укажите адрес Redis.
5. Примените миграции и запустите приложение.

## Как проверить Redis в этом сценарии

После входа в приложение выполните:

```bash
redis-cli KEYS 'sess:*'
```

Если появились ключи, сессии пишутся в Redis.

## Что важно помнить

### Секреты

В `development` приложение может стартовать без `SESSION_SECRET` и `CRYPTO_SECRET`, потому что у него есть fallback-значения. Для реальной рабочей установки это не рекомендуется.

### Порт

Локальный запуск через `npm start` использует:

- `PORT`, если он задан;
- иначе `3000`.

### Миграции

После первого запуска и после каждого обновления версии запускайте:

```bash
npm run db-update
```

### SQLite и MySQL не переключаются автоматически с переносом данных

Если вы начали на `SQLite`, а потом хотите перейти на `MySQL`, сами данные нужно переносить отдельно.
