# Проектирование LeavePilot License Portal MVP

Статус: **чёрновик (design specification)**. Документ описывает архитектуру и
план реализации внутреннего vendor-side портала для выпуска и учёта лицензий
LeavePilot Premium.

## 1. Назначение и рамки

### Что такое License Portal

Внутренний веб-сервис вендора для автоматизации выпуска, учёта и выдачи
лицензий LeavePilot Premium. Заменяет ручной workflow через `bin/sign_license.js`
и `bin/license.js` на веб-интерфейс с историей, аудитом и управлением
клиентами/планами.

### Что портал НЕ является

- **Не является** клиентским сервисом. Клиент никогда не взаимодействует с
  порталом напрямую.
- **Не является** лицензионным сервером в runtime. LeavePilot проверяет
  лицензию локально публичным ключом, без сети.
- **Не является** SaaS-продуктом. Портал развёрнут только во внутреннем
  периметре вендора.
- **Не заменяет** runtime-верификацию. Клиентский `lib/features.js` не
  изменяется.

### Почему только vendor-side

1. Приватный ключ подписи — критический секрет. Размещение у клиента
   (в БД, в контейнере, в sidecar) позволяет клиенту самостоятельно выпускать
   лицензии.
2. Клиент-сайд валидация (LicenseAPI и аналоги) обходится тривиально при
   наличии у клиента и сервера, и данных, и ключа.
3. Офлайн-модель (без phone-home) — осознанный выбор в пользу приватности
   и простоты. Портал не нарушает эту модель.

### Что остаётся офлайн у клиента

- Подписанный лицензионный blob (JSON или base64) и публичный ключ RSA —
  через переменные окружения; env-контракт нормативно определён
  [LICENSE-CONTRACT.md](../LICENSE-CONTRACT.md).
- `lib/features.js` — локальная проверка подписи при старте приложения.
- Никакой сети, phone-home, активации или heartbeat.

## 2. Цели MVP

Портал MVP должен поддерживать:

1. **Аутентификацию вендора** — вход только для авторизованных сотрудников.
2. **Управление клиентами** — создание, просмотр, редактирование записей о
   клиентах.
3. **Управление планами** — CRUD для тарифных планов с привязкой к фичам.
4. **Генерацию лицензий** — форма «клиент + план + срок» → подписанный blob.
5. **Скачивание/копирование лицензии** — получение blob в JSON/base64.
6. **Реестр выданных лицензий** — история с метаданными и хэшами.
7. **Импорт из registry.json** — миграция с Phase 2B-0 CLI-реестра.
8. **Аудит-лог** — кто, когда, какое действие выполнил.
9. **Файловый ключ для MVP** — подпись через PEM-файл, позже замена на KMS.
10. **Абстракцию провайдера подписи** — чтобы замена на KMS/HSM не меняла
    бизнес-логику портала.

## 3. Не-цели для MVP

Явно исключены из scope MVP:

- Онлайн-активация лицензий.
- Heartbeat / периодическая проверка.
- Отзыв лицензий до истечения срока.
- Клиентский лицензионный сервер.
- Жёсткий лимит инсталляций (лимит активных пользователей `maxActiveUsers`
  энфорсится community-верификатором — [LICENSE-CONTRACT.md](../LICENSE-CONTRACT.md)).
- Интеграция с LicenseAPI.
- Интеграция с биллингом/CRM.
- Мультитенантная SaaS-экспозиция.
- Публичный интернет-доступ.
- Мобильный UI.

## 4. Архитектура

### Компоненты

```
┌─────────────────────────────────────────────────────────────────┐
│                     Vendor Internal Network                     │
│                                                                 │
│  ┌──────────┐     ┌──────────────┐     ┌──────────────────┐    │
│  │ Browser  │────▶│  Web UI      │────▶│  Backend API     │    │
│  │ (admin)  │     │  (static)    │     │  (Node/Express)  │    │
│  └──────────┘     └──────────────┘     └────────┬─────────┘    │
│                                                  │              │
│                              ┌────────────────────┼──────────┐  │
│                              │                    │          │  │
│                              ▼                    ▼          │  │
│                    ┌──────────────┐     ┌──────────────┐     │  │
│                    │  Storage     │     │  Signing     │     │  │
│                    │  (SQLite/PG) │     │  Provider    │     │  │
│                    └──────────────┘     └──────┬───────┘     │  │
│                                                │             │  │
│                                    ┌───────────┴──────────┐  │  │
│                                    │                      │  │  │
│                                    ▼                      │  │  │
│                           ┌──────────────┐                │  │  │
│                           │  Private Key │                │  │  │
│                           │  (file/KMS)  │                │  │  │
│                           └──────────────┘                │  │  │
│                                                           │  │  │
│  ┌──────────────────────────────────────────────────────┐ │  │  │
│  │  Generated Output                                    │ │  │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌────────────┐  │ │  │  │
│  │  │ License blob │  │ Registry     │  │ Audit log  │  │ │  │  │
│  │  │ (download)   │  │ (DB records) │  │ (DB table) │  │ │  │  │
│  │  └─────────────┘  └──────────────┘  └────────────┘  │ │  │  │
│  └──────────────────────────────────────────────────────┘ │  │  │
│                                                           │  │  │
└───────────────────────────────────────────────────────────┘  │  │
                                                               │  │
┌──────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  Customer Environment (separate, no portal access)               │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  TIMEOFF_LICENSE=<signed blob>                             │  │
│  │  TIMEOFF_LICENSE_PUBLIC_KEY=<public key>                   │  │
│  │  lib/features.js → local RSA verification at startup       │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Поток генерации лицензии

1. Администратор открывает портал (VPN/SSO).
2. Выбирает клиента, план, срок действия.
3. Нажимает «Выпустить лицензию».
4. Backend формирует payload `{ customer, features[], plan, expires, ... }`.
5. Signing Provider подписывает payload приватным ключом.
6. Backend сохраняет метаданные + хэши в БД, логирует действие.
7. Администратор скачивает blob (JSON/base64) и передаёт клиенту.
8. Клиент вставляет blob в `TIMEOFF_LICENSE`, публичный ключ в
   `TIMEOFF_LICENSE_PUBLIC_KEY`.
9. При старте LeavePilot проверяет подпись локально — без сети, без портала.

### Связь с Phase 2B-0 CLI

Формат записей регистра (`--registry`) совместим с моделью данных портала.
Импорт `registry.json` в БД портала — первоначальная миграция.

## 5. Модель данных

### AdminUser — учётная запись вендора

| Поле           | Тип      | Описание |
|----------------|----------|----------|
| `id`           | UUID     | PK |
| `email`        | string   | Уникальный, для входа |
| `name`          | string   | Отображаемое имя |
| `role`         | enum     | `viewer`, `issuer`, `admin` |
| `passwordHash` | string   | scrypt-хеш (или SSO-subject) |
| `isActive`     | boolean  | Можно деактивировать |
| `createdAt`    | datetime | |
| `updatedAt`    | datetime | |

Индексы: unique(`email`).
Чувствительные поля: `passwordHash` — не отображается в API/UI.

### Customer — клиент вендора

| Поле           | Тип      | Описание |
|----------------|----------|----------|
| `id`           | UUID     | PK |
| `name`         | string   | Название организации |
| `contactEmail` | string   | Email контакта (опционально) |
| `contactName`  | string   | Имя контакта (опционально) |
| `notes`        | text     | Внутренние заметки |
| `createdAt`    | datetime | |
| `updatedAt`    | datetime | |

Индексы: unique(`name`).
В payload лицензии: `name` → поле `customer`.

### Plan — тарифный план

| Поле           | Тип      | Описание |
|----------------|----------|----------|
| `id`           | UUID     | PK |
| `name`         | string   | Уникальное имя (`starter`, `pro`, `enterprise`) |
| `description`  | string   | Описание |
| `features`     | JSON     | Массив имён фич |
| `isDefault`    | boolean  | План по умолчанию |
| `createdAt`    | datetime | |
| `updatedAt`    | datetime | |

Индексы: unique(`name`).
В payload лицензии: `name` → поле `plan`, `features` → поле `features`.

Начальные данные (seed): `starter`, `pro`, `enterprise` — как в
`config/plan_presets.json`.

### License — выпущенная лицензия

| Поле            | Тип      | Описание |
|-----------------|----------|----------|
| `id`            | UUID     | PK |
| `customerId`    | UUID     | FK → Customer |
| `planId`        | UUID     | FK → Plan |
| `features`      | JSON     | Скопированный список фич (на момент выпуска) |
| `expiresAt`     | datetime | Дата истечения (null = бессрочно) |
| `algorithm`     | string   | `RSA-SHA256` |
| `payloadHash`   | string   | SHA-256 канонического payload (hex, 64 char) |
| `licenseHash`   | string   | SHA-256 полного конверта (hex, 64 char) |
| `licensePayload`| text     | Полный JSON-конверт `{payload, algorithm, signature}` |
| `issuedAt`      | datetime | Дата выпуска |
| `issuedById`    | UUID     | FK → AdminUser, кто выпустил |
| `revokedAt`     | datetime | null (для будущего отзыва, не используется в MVP) |
| `importBatchId` | UUID     | FK → ImportBatch (null если не из импорта) |
| `createdAt`     | datetime | |
| `updatedAt`     | datetime | |

Индексы:
- `customerId`
- `planId`
- unique(`payloadHash`) — детекция дубликатов
- unique(`licenseHash`) — детекция дубликатов
- `issuedAt`
- `expiresAt`

Чувствительные поля: `licensePayload` — содержит подписанный blob. Отображается
только при скачивании, не в списках.

**Важно:** `licensePayload` хранится для удобства повторного скачивания. Это
не приватный ключ — это публично верифицируемый подписанный blob. Приватный
ключ никогда не хранится в БД.

### AuditLog — аудит-лог

| Поле          | Тип      | Описание |
|---------------|----------|----------|
| `id`          | UUID     | PK |
| `actorId`     | UUID     | FK → AdminUser |
| `action`      | string   | `create_customer`, `create_plan`, `issue_license`, `import_registry`, ... |
| `entityType`  | string   | `Customer`, `Plan`, `License`, `ImportBatch` |
| `entityId`    | UUID     | ID затронутой сущности |
| `details`     | JSON     | Детали действия (дифф, входные данные) |
| `ipAddress`   | string   | IP-адрес запроса |
| `createdAt`   | datetime | |

Индексы: `actorId`, `entityType`+`entityId`, `createdAt`.
Поле `details` не должно содержать приватный ключ, пароли или подписи.

### ImportBatch — пакет импорта registry.json

| Поле           | Тип      | Описание |
|----------------|----------|----------|
| `id`           | UUID     | PK |
| `fileName`     | string   | Имя загруженного файла |
| `totalEntries` | integer  | Всего записей в файле |
| `importedCount`| integer  | Успешно импортировано |
| `skippedCount` | integer  | Пропущено (дубликаты) |
| `errorCount`   | integer  | Ошибки валидации |
| `dryRun`       | boolean  | Был ли dry-run |
| `importedById` | UUID     | FK → AdminUser |
| `createdAt`    | datetime | |

### SigningKeyReference — ссылка на ключ (не сам ключ)

| Поле           | Тип      | Описание |
|----------------|----------|----------|
| `id`           | UUID     | PK |
| `name`         | string   | Человекочитаемое имя (`production-key-2026`) |
| `providerType` | string   | `file` (MVP) или `kms` (будущее) |
| `publicKeyPem` | text     | Публичный ключ (можно хранить) |
| `keyPath`      | string   | Путь к файлу (для `file`-провайдера, nullable) |
| `kmsKeyId`     | string   | ID ключа в KMS (для `kms`-провайдера, nullable) |
| `isActive`     | boolean  | Текущий активный ключ |
| `createdAt`    | datetime | |

**Приватный ключ НЕ хранится ни в каком поле.** Для `file`-провайдера путь
указывается в env/config, файл читается на лету. Для `kms` — используется
KMS API.

## 6. Модель лицензионного payload

Формат лицензионного конверта и payload — поля, типы, семантика, алгоритм
подписи, канонизация, версии схемы — нормативно определён контрактом
[LICENSE-CONTRACT.md](../LICENSE-CONTRACT.md) в корне репозитория (сегодня —
schemaVersion 2). Контракт — единственный норматив формата: этот раздел
сознательно не дублирует таблицы полей и примеры payload.

### Правила формирования payload на портале

Портал заполняет поля контракта из собственных данных (имена и семантика
полей — LICENSE-CONTRACT.md):

1. `features[]` берётся из плана, если не переопределён вручную.
2. `customerName`/`customerId` берутся из записи Customer.
3. Срок действия (`expiresAt`) задаётся при выпуске.
4. Лимит активных пользователей на компанию (`maxActiveUsers`) заполняется
   из поля портала `metadata.seats`.
5. Подпись — по правилам контракта (канонизация + `RSA-SHA256`).

## 7. Проектирование подписи

### Интерфейс провайдера

```javascript
class SigningProvider {
  // Подписать payload → вернуть { payload, algorithm, signature }
  async sign(payload) {}

  // Получить публичный ключ в PEM (для отображения/передачи клиенту)
  async getPublicKeyPem() {}

  // Получить информацию о провайдере (тип, имя ключа)
  getInfo() {}
}
```

### FileSigningProvider (MVP)

- Читает приватный PEM-файл по пути из конфигурации.
- Подписывает через `crypto.sign('RSA-SHA256', ...)`.
- Публичный ключ извлекается из приватного или задаётся отдельно.
- Путь к файлу — в env (`LICENSE_SIGNING_KEY_PATH`) или config, **не в БД**.

### KmsSigningProvider (Phase 2C)

- Использует AWS KMS / GCP KMS / HashiCorp Vault.
- Вызывает KMS API для подписи.
- Приватный ключ не покидает KMS.
- `kmsKeyId` хранится в `SigningKeyReference`.

### Правила безопасности

- Приватный ключ **никогда** не хранится в БД.
- Приватный ключ **никогда** не передаётся в браузер.
- Приватный ключ **никогда** не логируется.
- Путь к файлу ключа — только в env/config, не в UI.
- Сгенерированная лицензия может храниться в БД для повторного скачивания
  (это подписанный blob, не секрет).
- Регистр хранит метаданные и хэши; полный blob — опционально.

## 8. API-дизайн

Все endpoints — под префиксом `/license-portal/`, только для аутентифицированных
администраторов.

### Auth

```
POST /license-portal/auth/login
POST /license-portal/auth/logout
GET  /license-portal/auth/me
```

### Customers

```
GET    /license-portal/customers              Список клиентов
POST   /license-portal/customers              Создать клиента
GET    /license-portal/customers/:id          Детали клиента
PUT    /license-portal/customers/:id          Обновить клиента
GET    /license-portal/customers/:id/licenses Лицензии клиента
```

**POST /customers:**
```json
// Request
{ "name": "ООО Ромашка", "contactEmail": "admin@romashka.ru", "notes": "..." }

// Response (201)
{ "id": "...", "name": "ООО Ромашка", "contactEmail": "...", "createdAt": "..." }
```

Валидация: `name` обязателен, уникален.

### Plans

```
GET    /license-portal/plans                  Список планов
POST   /license-portal/plans                  Создать план
GET    /license-portal/plans/:id              Детали плана
PUT    /license-portal/plans/:id              Обновить план
```

**POST /plans:**
```json
// Request
{
  "name": "custom",
  "description": "Custom plan",
  "features": ["sso_authentication", "integration_api"]
}

// Response (201)
{ "id": "...", "name": "custom", "features": [...], "createdAt": "..." }
```

Валидация: `name` обязателен, уникален. `features` — массив строк.

### Licenses

```
GET    /license-portal/licenses                Список лицензий (с пагинацией)
POST   /license-portal/licenses                Выпустить лицензию
GET    /license-portal/licenses/:id            Детали лицензии
GET    /license-portal/licenses/:id/download   Скачать blob (JSON или base64)
```

**POST /licenses:**
```json
// Request
{
  "customerId": "...",
  "planId": "...",
  "expiresAt": "2027-12-31",
  "features": null
}

// Если features=null, берутся из плана. Если указаны — переопределяют план.

// Response (201)
{
  "id": "...",
  "customerId": "...",
  "planId": "...",
  "features": [...],
  "expiresAt": "2027-12-31",
  "payloadHash": "...",
  "licenseHash": "...",
  "issuedAt": "...",
  "issuedBy": { "id": "...", "name": "..." }
}
```

Валидация:
- `customerId` обязателен, должен существовать.
- `planId` обязателен, должен существовать.
- `expiresAt` — ISO-дата в будущем (или null для бессрочной).
- Генерация: payload → подпись → сохранение → аудит.

**GET /licenses/:id/download?format=json|base64:**
Возвращает `application/octet-stream` с содержимым лицензии.

### Import

```
POST   /license-portal/import/registry-json   Импорт registry.json
```

**POST /import/registry-json:**
```json
// Request (multipart/form-data)
// file: registry.json
// dryRun: true|false

// Response (200)
{
  "batchId": "...",
  "totalEntries": 10,
  "importedCount": 8,
  "skippedCount": 2,
  "errorCount": 0,
  "details": [
    { "index": 1, "customer": "...", "status": "imported" },
    { "index": 2, "customer": "...", "status": "skipped", "reason": "duplicate payloadHash" }
  ]
}
```

Валидация:
- Файл должен быть JSON-массивом.
- Каждая запись проверяется на наличие обязательных полей.
- Дубликаты определяются по `payloadHash` (unique constraint).
- `dryRun=true` — только валидация, без записи в БД.

### Audit

```
GET    /license-portal/audit                   Аудит-лог (с фильтрами)
```

Параметры: `actorId`, `action`, `entityType`, `from`, `to`, `limit`, `offset`.

## 9. UI-дизайн

### Dashboard (`/`)

- Количество клиентов, планов, активных лицензий.
- Последние 5 выпусков лицензий.
- Кнопки: «Выпустить лицензию», «Импортировать реестр».
- Предупреждение о скоре истечении лицензий (ближайшие 30 дней).

### Customers list (`/customers`)

- Таблица: имя, email, количество лицензий, дата создания.
- Кнопка «Добавить клиента».
- Пустое состояние: «Пока нет клиентов. Добавьте первого.».

### Customer detail (`/customers/:id`)

- Имя, email, заметки.
- Список выданных лицензий (срок, план, статус).
- Кнопка «Выпустить лицензию для этого клиента».
- Кнопка «Редактировать».

### Plans list (`/plans`)

- Таблица: имя, описание, количество фич, количество выпущенных лицензий.
- Кнопка «Добавить план».
- Seed-планы (starter/pro/enterprise) отмечены как системные.

### Create license form (`/licenses/new`)

- Выпадающий список клиента.
- Выпадающий список плана.
- Поле даты истечения.
- Чекбоксы фич (предзаполнены из плана, можно переопределить).
- Превью payload перед выпуском.
- Кнопка «Выпустить и скачать».
- Кнопка «Выпустить» (сохранить в БД, скачать позже).

### Issued licenses list (`/licenses`)

- Таблица: клиент, план, фичи, срок, дата выпуска, кто выпустил.
- Фильтры: клиент, план, статус (активная/истекшая).
- Пустое состояние: «Лицензии ещё не выпускались.».

### License detail (`/licenses/:id`)

- Все метаданные.
- Payload preview (без подписи).
- Кнопки: «Скачать JSON», «Скачать base64».
- Статус: активна / истекает скоро / истекла.
- Ссылка на клиента и план.

### Import registry.json (`/import`)

- Файл-загрузчик.
- Чекбокс «Dry run».
- Результат: таблица с каждой записью (импортирована/пропущена/ошибка).
- Кнопка «Подтвердить импорт» (после dry-run).

### Audit log (`/audit`)

- Таблица: время, действие, объект, пользователь, IP.
- Фильтры: тип действия, пользователь, период.
- Детали действия — раскрывающийся JSON.

## 10. Аутентификация и контроль доступа

### MVP: внутренняя аутентификация

- Логин/пароль через `AdminUser`.
- Сессия на cookie (httpOnly, secure, sameSite).
- Нет публичной регистрации.
- Нет сброса пароля через email (admin создаёт учётные записи).

### Продакшн: SSO/VPN

- Портал развёрнут за VPN вендора.
- SSO через существующий IdP (Keycloak и т.д.).
- Авторизация по группам/ролям IdP.

### Роли

| Роль       | Просмотр | Выпуск | Управление | Импорт | Аудит |
|------------|----------|--------|------------|--------|-------|
| `viewer`   | +        | -      | -          | -      | +     |
| `issuer`   | +        | +      | -          | -      | +     |
| `admin`    | +        | +      | +          | +      | +     |

- `viewer` — просмотр клиентов, планов, лицензий, аудита.
- `issuer` — всё из viewer + выпуск лицензий.
- `admin` — всё из issuer + управление клиентами/планами, импорт, настройки.

### Правила

- Нет публичных endpoints.
- Нет доступа для клиентов.
- Все действия логируются в `AuditLog`.
- Неудачные попытки входа логируются с IP.

## 11. Миграция registry.json

### Ожидаемый формат (Phase 2B-0)

```json
[
  {
    "customer": "ООО Ромашка",
    "plan": "pro",
    "features": ["sso_authentication", "integration_api"],
    "algorithm": "RSA-SHA256",
    "issuedAt": "2026-06-27T10:00:00.000Z",
    "issuedBy": "alekse",
    "payloadHash": "01fd85c07d06ff3f...",
    "licenseHash": "e783113c7a5d9899...",
    "outputFile": "/path/to/license.json"
  }
]
```

### Валидация импорта

1. Файл должен быть валидным JSON-массивом.
2. Каждая запись проверяется:
   - `customer` обязателен.
   - `features` должен быть массивом.
   - `payloadHash` обязателен (для детекции дубликатов).
3. Отсутствующие поля обрабатываются gracefully:
   - `plan` → null, если не указан.
   - `expires` → null (бессрочная).
   - `issuedAt` → дата импорта.
   - `issuedBy` → строка сохраняется как-is в `notes`.

### Детекция дубликатов

- По `payloadHash` (unique constraint в таблице License).
- Дубликаты пропускаются с пометкой `skipped`.
- Не перезаписывают существующие записи.

### Dry-run режим

- `dryRun=true` — только валидация и отчёт, без записи в БД.
- Показывает: сколько будет импортировано, сколько пропущено, какие ошибки.

### Отчёт импорта

```json
{
  "batchId": "...",
  "totalEntries": 10,
  "importedCount": 8,
  "skippedCount": 2,
  "errorCount": 0,
  "details": [...]
}
```

### Ограничения импорта

- Импортируются только метаданные и хэши.
- Полный `licensePayload` (blob) **не** импортируется из registry.json
  (его там нет по дизайну Phase 2B-0).
- Если blob нужен — клиент должен предоставить файл лицензии отдельно
  (или лицензия будет перевыпущена через портал).

## 12. Выбор хранилища

### SQLite (рекомендовано для MVP)

**Плюсы:**
- Нулевая инфраструктура — один файл.
- Встроен в Node.js (better-sqlite3 или Sequelize с sqlite3).
- Достаточно для single-admin сценария.
- Простое резервное копирование (cp файла).
- Подходит для Docker-развёртывания.

**Минусы:**
- Не подходит для одновременной работы нескольких администраторов
  (write lock на уровне файла).
- Нет встроенной аутентификации.
- Сложнее масштабировать.

### PostgreSQL (для командного использования)

**Плюсы:**
- Поддержка конкурентных записей.
- Встроенная аутентификация.
- Хорошо масштабируется.
- JSON-поля для гибких метаданных.

**Минусы:**
- Требует отдельный сервис (Docker-контейнер).
- Сложнее резервное копирование.
- Overhead для single-admin сценария.

### Рекомендация

**MVP → SQLite.** При необходимости командного доступа → миграция на
PostgreSQL через Sequelize (диалект — конфигурационный параметр).
Sequelize уже используется в LeavePilot, поэтому ORM-слой будет единым.

## 13. Безопасность и модель угроз

| Угроза | Вероятность | Влияние | Митигация |
|--------|-------------|---------|-----------|
| **Кража приватного ключа** | Средняя | Критическое | Ключ не в БД; файл — с restricted permissions; KMS в Phase 2C |
| **Случайный коммит ключа** | Средняя | Критическое | `.gitignore` + pre-commit hook + CI scan |
| **Утечка БД портала** | Низкая | Высокое | БД не содержит приватных ключей; лицензии — подписанные blob (не секреты); пароли — scrypt |
| **Утечка registry.json** | Средняя | Среднее | Содержит только метаданные; нет подписей, нет ключей |
| **Компрометация аккаунта админа** | Низкая | Высокое | Аудит-лог; роли; 2FA (будущее); VPN/SSO gating |
| **Копирование лицензии клиентом** | Неизбежная | Среднее | Офлайн-ограничение; идентификация клиента в payload (`customerId`, формат — LICENSE-CONTRACT.md) |
| **Откат часов** | Низкая | Среднее | Короткий срок лицензии; `issuedAt` в payload |
| **Отсутствие отзыва** | Архитектурное | Среднее | Осознанный выбор; смягчение — короткий срок + ре-выпуск |
| **Подделка аудит-лога** | Низкая | Среднее | Append-only таблица; отдельные права на DELETE; будущее — хэш-цепочка |
| **Потеря БД** | Низкая | Высокое | Регулярные бэкапы; registry.json как резервная копия метаданных |
| **Потеря приватного ключа** | Низкая | Критическое | Бэкап ключа в зашифрованном хранилище; процедура ротации |

### Правила хранения ключей

1. Приватный ключ — в зашифрованном хранилище (KMS, vault, encrypted disk).
2. Публичный ключ — можно хранить в БД и передавать клиенту.
3. Резервная копия ключа — в отдельном зашифрованном хранилище.
4. Процедура ротации: генерация новой пары → выпуск новых лицензий →
   отзыв старого ключа (publish new public key, deprecate old).

## 14. Docker/развёртывание

### Только vendor-side

Портал не поставляется клиенту. Развёртнут во внутренней сети вендора.

### Docker Compose (портал)

```yaml
services:
  portal:
    build: .
    ports:
      - "8080:8080"
    environment:
      NODE_ENV: production
      SESSION_SECRET: ${SESSION_SECRET}
      DATABASE_URL: ${DATABASE_URL:-./data/portal.sqlite}
      LICENSE_SIGNING_KEY_PATH: /run/secrets/license_private_key
      LICENSE_PUBLIC_KEY_PATH: /run/secrets/license_public_key
    volumes:
      - portal_data:/app/data
      - license_output:/app/licenses
    secrets:
      - license_private_key
      - license_public_key

volumes:
  portal_data:
  license_output:

secrets:
  license_private_key:
    file: ./secrets/license_private.pem
  license_public_key:
    file: ./secrets/license_public_key.pem
```

### Сетевая изоляция

- Портал слушает только на внутреннем интерфейсе (127.0.0.1 или VPN-IP).
- Reverse proxy (nginx/caddy) с TLS termination.
- SSO/VPN gating на уровне reverse proxy.
- Нет публичного DNS.
- Firewall: разрешён только трафик из VPN.

### Резервное копирование

1. **БД** — регулярный `cp` (SQLite) или `pg_dump` (PostgreSQL).
2. **Registry/license output** — копирование директории `licenses/`.
3. **Приватный ключ** — отдельная зашифрованная копия.
4. **Частота** — ежедневно для БД, при каждом выпуске для лицензий.

## 15. План реализации

### Phase 2B-1: модель данных + импорт

- Sequelize-модели: `AdminUser`, `Customer`, `Plan`, `License`, `AuditLog`,
  `ImportBatch`, `SigningKeyReference`.
- Миграции (SQLite + PostgreSQL).
- Seed: планы из `config/plan_presets.json`.
- CLI-скрипт или endpoint для импорта `registry.json`.
- Тесты моделей и импорта.

### Phase 2B-2: backend API

- Express-роуты: auth, customers, plans, licenses, import, audit.
- Signing Provider (file-based).
- Валидация, аудит-логирование.
- API-тесты.

### Phase 2B-3: минимальный UI

- Handlebars или простой SPA (React/Vue).
- Страницы: dashboard, customers, plans, licenses, import.
- Форма выпуска лицензии.
- Скачивание blob.

### Phase 2B-4: аудит-лог

- UI для просмотра аудита.
- Фильтры и поиск.
- Экспорт в CSV.

### Phase 2B-5: Docker и документация

- `Dockerfile` для портала.
- `docker-compose.yml` (portal + optional PostgreSQL).
- Документация развёртывания.
- Документация резервного копирования.
- Runbook для ежедневных операций.

### Phase 2C: KMS/HSM

- `KmsSigningProvider` (AWS KMS / GCP KMS / Vault).
- Конфигурация KMS.
- Миграция с file-based на KMS без изменения UI/API.

### Phase 3: расширенные метаданные

- Поля `maxActiveUsers` (из `metadata.seats`) и `customerId` в payload —
  по контракту [LICENSE-CONTRACT.md](../LICENSE-CONTRACT.md).
- Валидация в рантайме (опционально).
- UI для заполнения полей.

### Phase 4: активация/heartbeat (если потребуется)

- Отдельная подсистема.
- Вводится только при подтверждённой бизнес-необходимости.

## 16. Критерии приёмки MVP

Будущий Portal MVP считается принятым только если:

1. Генерирует лицензии в формате [LICENSE-CONTRACT.md](../LICENSE-CONTRACT.md).
2. Рантайм-верификация (`lib/features.js`) не изменена.
3. Приватный ключ не хранится в БД портала.
4. Клиент-сайд сервис не вводится.
5. Сгенерированная лицензия проходит `bin/license.js verify`.
6. Импортированные записи `registry.json` сохранены в БД.
7. Все действия по выпуску лицензий логируются в `AuditLog`.
8. Документация описывает backup/restore и обращение с ключами.
9. Портал не экспонирован в публичный интернет.
10. Роли `viewer`/`issuer`/`admin` работают корректно.

---

## Открытые вопросы

1. **SSO для портала:** использовать существующий Keycloak или встроенный
   auth? Рекомендация: встроенный auth для MVP, SSO — Phase 2B-5.
2. **Хранилище лицензионных blobs:** хранить в БД или в файловой системе?
   Рекомендация: БД для простоты, файловая — при большом объёме.
3. **Формат экспорта:** помимо скачивания blob, нужен ли email-шаблон для
   отправки клиенту? Рекомендация: нет, ручная отправка для MVP.
4. **Ротация ключей:** как часто? Процедура? Рекомендация: ежегодно + при
   компрометации; документировать процедуру в Phase 2B-5.
5. **Интеграция с CRM:** нужна ли интеграция с внешним CRM для MVP?
   Рекомендация: нет, только внутренний реестр клиентов.
6. **Мульти-продукт:** портал будет обслуживать только LeavePilot или
   несколько продуктов? Рекомендация: только LeavePilot для MVP.

## Рекомендуемый первый PR после принятия дизайна

**Phase 2B-1: data models + registry import**

Scope:
- Sequelize-модели всех сущностей.
- Миграции (SQLite).
- Seed для планов.
- CLI-скрипт `bin/import-registry.js` для миграции с Phase 2B-0.
- Unit-тесты моделей и импорта.

Files:
```
A  portal/models/admin_user.js
A  portal/models/customer.js
A  portal/models/plan.js
A  portal/models/license.js
A  portal/models/audit_log.js
A  portal/models/import_batch.js
A  portal/models/signing_key_reference.js
A  portal/migrations/...
A  portal/seeders/...
A  bin/import-registry.js
A  t/unit/portal/models.js
A  t/unit/portal/import_registry.js
```

### Phase 2B-1 — статус реализации

Реализовано:
- Модели: Customer, Plan, License, ImportBatch, AuditLog, SigningKeyReference
  (AdminUser отложен до Phase 2B-2 auth).
- Хранилище: SQLite через Sequelize, in-memory для тестов.
- Seed планов из `config/plan_presets.json` (идемпотентный).
- CLI импорт `bin/import-registry.js` с `--dry-run`, детекцией дубликатов,
  валидацией, аудит-логом.
- `actorName` (строка) вместо `actorId` (FK) до реализации AdminUser.
- SigningKeyReference — только метаданные, без приватного ключа.
- Тесты: 23 теста для моделей, seed, импорта.

Не реализовано в этом PR:
- AdminUser/login/auth (Phase 2B-2).
- Web UI (Phase 2B-3).
- API routes (Phase 2B-2).
- Отдельные миграции Umzug (MVP использует sequelize.sync, миграции — Phase 2B-2).

### Phase 2B-2 — статус реализации

Реализовано:
- **Signing Provider**: `FileSigningProvider` с интерфейсом `sign()` / `getPublicKeyPem()` /
  `getInfo()`. Канонический JSON как в `lib/features.js`. Приватный ключ — из файла
  или env, никогда не логируется и не сериализуется (`toJSON()`).
- **License Service**: `issueLicense()` — формирует payload совместимый с `TIMEOFF_LICENSE`,
  подписывает через провайдер, вычисляет `payloadHash`/`licenseHash`, сохраняет
  `licensePayload` в БД, создаёт AuditLog.
- **Customer/Plan Services**: `listCustomers`, `createCustomer`, `getCustomer`,
  `listPlans`, `getPlan`.
- **License query**: `listLicenses` (без blob), `getLicense` (без blob), `getLicenseBlob`.
- **API Router**: Express router `/license-portal/` с endpoints:
  - `GET /customers`, `POST /customers`
  - `GET /plans`
  - `GET /licenses`, `POST /licenses`, `GET /licenses/:id`, `GET /licenses/:id/download`
  - Не смонтирован в `app.js` — изолирован для тестов и будущего сервиса.
  - Нет auth middleware — TODO для будущих фаз.
- Тесты: 31 тест для signing, services, API endpoints.

Не реализовано:
- AdminUser / auth / session (Phase 2B-3+).
- Web UI (Phase 2B-3).
- Docker deployment (Phase 2B-5).
- KMS signing (Phase 2C).

### Phase 2B-3 — статус реализации

Реализовано:
- **AdminUser модель**: email (unique), displayName, passwordHash (scrypt),
  role (viewer/issuer/admin), isActive, lastLoginAt, failedLoginCount, lockedUntil.
- **Password hashing**: scrypt через `lib/auth/password.js` (reuse), per-user salt,
  timing-safe comparison. Без MD5 fallback для portal users.
- **Session**: `express-session` с memory store (dev/test). Production —
  persistent store перед развёртыванием.
- **Auth endpoints**: `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`.
- **Auth middleware**: `requireAuth`, `requireRole(...)`.
- **Role-based access**:
  - viewer: GET customers/plans/licenses
  - issuer: всё из viewer + POST /licenses
  - admin: всё из issuer + POST /customers
- **Lockout**: 5 неудачных попыток → блокировка на 15 минут.
- **Audit logging**: login_success, login_failed, logout, issue_license (actorName=email).
- **Password safety**: passwordHash не возвращается ни из одного API endpoint.
- Тесты: 47 тестов для signing, password, auth, roles, audit, safety.

Не реализовано:
- Web UI (Phase 2B-4).
- SSO/VPN gating (Phase 2B-5).
- Docker deployment (Phase 2B-5).
- Persistent session store (Phase 2B-5).
- KMS signing (Phase 2C).

### Phase 2B-4 — статус реализации

Реализовано:
- **Portal Web App**: `createPortalWebApp({ models, signingProvider, sessionSecret })`.
  Изолированный Express app, не монтируется в customer runtime.
- **Templating**: Handlebars (уже в проекте).
- **Страницы**:
  - `GET /login`, `POST /login` — форма входа, generic error, CSRF.
  - `GET /` — dashboard: counts customers/plans/licenses, recent licenses.
  - `GET /customers`, `GET /customers/new`, `POST /customers` (admin).
  - `GET /plans` — список планов с фичами.
  - `GET /licenses`, `GET /licenses/new`, `POST /licenses` (issuer/admin).
  - `GET /licenses/:id` — детали (без licensePayload).
  - `GET /licenses/:id/download` — скачивание JSON blob.
  - `POST /logout`.
- **RBAC**: viewer (просмотр), issuer (+выпуск), admin (+создание клиентов).
  Кнопки скрыты для неразрешённых ролей, backend проверяет дополнительно.
- **CSRF**: session-backed token на всех POST endpoints.
- **Security**: passwordHash/Private key не в HTML, escapeHtml для user input,
  HttpOnly + SameSite=Lax cookies.
- Тесты: 27 тестов (login, RBAC, security, CSRF, isolation).

Блокеры перед production deploy:
- Persistent session store (Redis/DB) вместо memory.
- SSO/VPN gating.
- TLS/reverse proxy.
- Docker deployment.
- Backup portal DB.

### Phase 2B-5 — статус реализации

Реализовано:
- **Portal entrypoint**: `bin/license_portal.js` — загружает конфиг, валидирует
  production env, инициализирует БД, seed планов, запускает HTTP на `PORTAL_PORT`.
- **Persistent session store**: `connect-session-sequelize` для production,
  memory store только для dev/test. Production не запустится без store.
- **Config**: `portal/config.js` — `getPortalConfig()`, `validateProductionConfig()`,
  `ensureDbDirectory()`. Fail-fast на отсутствующие production переменные.
- **Admin CLI**: `bin/portal_admin.js` — `create-admin`, `list-admins`,
  `disable-admin`, `reset-password`. Пароли хранятся в scrypt.
- **Health endpoint**: `GET /healthz` — `{ok, service, db}`. Без секретов.
- **Docker**: `Dockerfile.portal`, `docker-compose.portal.yml`. Приватный ключ
  через Docker secrets, БД через volume, порт только на 127.0.0.1.
- **Docs**: `docs/license-portal-deployment.md` — quick start, Docker Compose,
  admin CLI, reverse proxy (Caddy/nginx), backup/restore, production checklist.
- Тесты: 18 тестов для config, session store, health, admin CLI, isolation.
- **Production env vars**: PORTAL_SESSION_SECRET, PORTAL_LICENSE_PRIVATE_KEY_FILE,
  PORTAL_LICENSE_PUBLIC_KEY_FILE (обязательные), PORTAL_PORT, PORTAL_DB_STORAGE,
  PORTAL_SESSION_SECURE (опциональные).

### Phase 2D-1 — статус реализации

Реализовано:
- **Аудит-лог страница**: `GET /audit` (admin only). Последние 100 записей,
  newest first. Показывает timestamp, actorName, action, entityType, entityId,
  details summary. Details escaped, no secrets in HTML.
- **Registry export**: `GET /licenses/export/registry.json` (admin only).
  Экспортирует безопасные метаданные: customer, plan, features, expires,
  algorithm, issuedAt, issuedBy, payloadHash, licenseHash. Без licensePayload,
  signature, private key, passwordHash.
- **Audit events**: registry_export, license_download логируются в AuditLog.
- **Navigation**: ссылка "Аудит" в nav для admin.
- Тесты: 11 новых (audit access, export RBAC, export safety, audit logging).

Это portal metadata only — не механизм отзыва. Клиентский рантайм остаётся
офлайн и не обращается к порталу.

### Phase 2D-2 — статус реализации

Реализовано:
- **Фильтры на /licenses**: customer (substring), plan (exact), status
  (active/expired/all), q (поиск по hash/customer/plan).
- **UI**: компактная форма фильтров, сохранение выбранных значений, кнопка
  "Сбросить", "Ничего не найдено" при пустом результате.
- **Лимит**: 100 новейших записей (отображается в UI).
- Тесты: 9 новых (filters, RBAC, empty state, no licensePayload).

Фильтры — portal metadata/search only, не влияют на валидность лицензий
и не обращаются к клиентскому рантайму.

### Phase 2D-3 — статус реализации

Реализовано:
- **Customer detail**: `GET /customers/:id` (viewer/issuer/admin). Показывает
  name, email, contact, createdAt, licenseCount, latestIssuedAt + список
  последних 20 лицензий (plan, features, status, expires, issuedBy, hashes).
- **Empty state**: "Лицензий для этого клиента пока нет."
- **Customers list**: имена клиентов теперь кликабельны → detail.
- **Navigation**: back to customers, link to licenses filtered by customer.
- Тесты: 12 новых (detail access, 404, metadata, no leak, empty state).
- Route ordering fixed: `/customers/new` и POST `/customers` определены
  ДО `/customers/:id`, чтобы `new` не перехватывался как `:id`.

Detail — operational metadata only, не влияет на рантайм.

### Phase 2D-4 — статус реализации

Реализовано:
- **Backup script**: `bin/license_portal_backup.js` — копирует SQLite файл
  с таймстемпом, создаёт parent dirs, отказывается перезаписывать, не
  печатает секреты.
- **Backup/restore smoke test**: `t/unit/portal/backup_restore.js` — 6 тестов:
  backup creation, data count preservation, no private key in backup,
  fail on missing/in-memory DB, mkdir behavior.
- **Docs**: обновлена `docs/license-portal-deployment.md` — backup script usage,
  restore procedure, warnings about private key and password hashes.

### Phase 2D-5 — статус реализации

Реализовано:
- **Admin CLI hardened**: `bin/portal_admin.js` — `--password-env` вместо
  `--password` (защита от shell history). Валидация: min 12 chars, пустая
  пароль → fail, невалидный env → fail. Пароль/хэш никогда не печатаются.
- **Команды**: `create`, `list`, `disable`, `reset-password`.
- **Reset password**: очищает `failedLoginCount` и `lockedUntil`.
- Тесты: 17 новых (create, list, disable, reset, error handling, safety).
- Docs: обновлен `docs/license-portal-deployment.md` — password-env workflow.

Нет public self-registration. Нет веб-bootstrap страницы.

### Phase 3A — статус реализации

Реализовано:
- **License metadata**: JSON-поле `metadata` на модели License. Поля:
  `metadata.seats` (int 1..1M; в лицензию попадает как `maxActiveUsers` —
  по контракту [LICENSE-CONTRACT.md](../LICENSE-CONTRACT.md)),
  `customerDomains` (массив доменов, нормализация, дедупликация),
  `externalCustomerId` (строка), `operatorNotes` (строка).
- **Валидация**: `portal/services/license_metadata.js` — проверка типов,
  длин, форматов, доменных паттернов. Валидация перед записью в БД.
- **Issue flow**: форма выпуска лицензии с опциональными metadata полями.
  Metadata хранится на License; в payload/signature попадает только
  `maxActiveUsers` (из `metadata.seats`), остальные поля metadata в payload
  НЕ входят.
- **License detail**: показывает `metadata.seats`, customerDomains,
  externalCustomerId, operatorNotes (escaped). operatorNotes не
  экспортируется.
- **Registry export**: включает `metadata.seats`, customerDomains,
  externalCustomerId. Исключает operatorNotes, licensePayload, signature.
- **Audit**: `metadata.seats`, `domainCount`, `externalCustomerIdPresent`,
  operatorNotesPresent. operatorNotes значение не в деталях.
- Тесты: 8 новых (metadata storage, detail, export, audit, safety).

### Phase 2D-6 — статус реализации

Реализовано:
- **CLI audit logging**: create/disable/reset-password записывают AuditLog
  в транзакции (user + audit в одной транзакции).
- **CLI actor**: `--actor-email` для указания оператора; fallback
  `portal-admin-cli`. Валидация через `normalizeEmail()`.
- **Audit actions**: `admin_user_create`, `admin_user_disable`,
  `admin_user_reset_password`. Без паролей, хэшей, токенов в деталях.
- Тесты: 9 новых (audit create/disable/reset, actor, fallback,
  failed create, list no audit, invalid actor-email).

### Phase 3B — статус реализации

Реализовано:
- **Metadata filters**: `externalCustomerId` (contains), `domain` (exact,
  normalized), `minSeats`, `maxSeats` — query params на `/licenses`.
- **Filter safety**: wildcard-only значения → пустой результат; невалидные
  домены → пустой результат; minSeats/maxSeats валидируются как integers.
- **UI**: новые поля фильтров в licenses list (compact layout).
- **Audit safety**: operatorNotes не ищется через q, не экспортируется.
- Тесты: 13 новых (metadata filters, safety, regression).

Фильтры — operator convenience only, не влияют на рантайм/подпись.

### Phase 3D — статус реализации

Реализовано:
- **Lifecycle metadata**: `issueReason` (enum: new/renewal/replacement/correction/trial/other),
  `replacementOfLicenseId` (UUID, валидация на существование и ту же компанию),
  `lifecycleNote` (строка, max 500, не экспортируется).
- **Cross-validation**: replacement требует replacementOfLicenseId; replacementOfLicenseId
  требует issueReason=replacement.
- **Issue form**: lifecycle section (issueReason select, replacementOfLicenseId input,
  lifecycleNote textarea).
- **License detail**: показывает issueReason, replacementOfLicenseId как ссылку,
  replacedBy licenses, lifecycleNote escaped.
- **Registry export**: включает issueReason, replacementOfLicenseId.
- **Filter**: `issueReason` exact match на /licenses.
- **Audit**: issueReason, replacementOfLicenseIdPresent, lifecycleNotePresent.
- Тесты: 12 новых (validation, issue, detail, filter, export).

### Phase 3C — статус реализации

Реализовано:
- **Пагинация**: `page` (default 1), `perPage` (default 50, max 100).
  Previous/Next ссылки с сохранением фильтров.
- **Рефакторинг фильтров**: `portal/services/license_list_filters.js` —
  чистые helper-функции: `parseSeatsFilter`, `normalizeDomainFilter`,
  `parsePagination`, `buildFilterState`, `buildDbFilters`,
  `licenseMatchesMetadataFilters`.
- **Metadata filtering**: DB-level фильтры (customer/plan/status/q) сначала,
  затем in-memory metadata фильтры с SCAN_CAP=5000.
  Предупреждение при достижении cap: "Поиск ограничен последними 5000 записями."
- **Сброс фильтров**: includes all filter params.
- Тесты: 20 новых (pagination, filter helpers, scan cap, safety).

## Связанные материалы

- [Контракт формата лицензии](../LICENSE-CONTRACT.md) — норматив формата
  payload, подписи и env-имён (schemaVersion 2)
- [Операции с лицензиями](license-operations.md) — CLI workflow
- [Развёртывание портала](license-portal-deployment.md) — Docker, admin CLI, backup
- [Premium-модуль](premium-module.md) — установка и конфигурация
- [Docker Compose](docker-compose.md) — развёртывание
