# Операции с лицензиями LeavePilot

Руководство вендора по выпуску, проверке и развёртыванию лицензий LeavePilot Premium.

## Формат лицензии

Лицензия — это подписанный JSON-конверт:

```json
{
  "payload": {
    "customer": "ООО Ромашка",
    "plan": "pro",
    "features": ["sso_authentication", "integration_api", "employee_groups", "work_calendars"],
    "expires": "2027-12-31"
  },
  "algorithm": "RSA-SHA256",
  "signature": "<base64 RSA-SHA256 подписи канонического JSON payload>"
}
```

### Поля payload

Схема v1 (legacy, продолжает проверяться без изменений):

| Поле       | Тип     | Обязательно | Описание |
|------------|---------|-------------|----------|
| `customer` | string  | да          | Имя клиента |
| `plan`     | string  | нет         | Имя тарифного плана (информационное) |
| `features` | string[]| да          | Список включённых фич |
| `expires`  | string  | нет         | Дата истечения в ISO 8601 (без поля — бессрочно) |

### Схема v2 (по умолчанию для новых лицензий)

`bin/sign_license.js` выпускает v2-payload по умолчанию (`--schema 1` — legacy).
Дополнительные поля:

| Поле | Тип | Обязательно | Описание |
|------|-----|-------------|----------|
| `schemaVersion` | number | да (=2) | Версия схемы payload |
| `licenseId` | string | да | Уникальный идентификатор лицензии (UUID); основа будущего отзыва |
| `customerName` | string | да | Отображаемое имя клиента |
| `customerId` | string | нет | Стабильный идентификатор клиента (CRM/портал) |
| `issuedAt` | string | да | Дата выпуска (ISO 8601) |
| `notBefore` | string | нет | Лицензия недействительна до этой даты |
| `expiresAt` | string | нет | Дата истечения (заменяет `expires`; verifier принимает оба) |
| `maintenanceUntil` | string | нет | Срок обновлений/поддержки (информационное) |
| `maxActiveUsers` | number | нет | Число лицензированных пользователей (мягкий лимит, офлайн не enforce'ится) |
| `allowedMajorVersions` | number[] | нет | Разрешённые major-версии ядра; несовпадение = лицензия недействительна |
| `keyId` | string | нет | Идентификатор ключа подписи для ротации через key ring |

### Grace-период при истечении

Истечение — коммерческое условие, а не признак взлома, поэтому оно **не роняет
приложение**:

- после `expiresAt` действует grace-период (по умолчанию **14 дней**,
  настраивается `TIMEOFF_LICENSE_GRACE_DAYS`); Premium-функции продолжают
  работать, в логах — заметное предупреждение;
- после grace Premium-функции отключаются, но приложение стартует: Community
  остаётся полностью рабочим, доступ к данным клиент не теряет;
- за 60 дней до истечения при старте пишется предупреждение с числом
  оставшихся дней (`getLicenseStatus().daysUntilExpiry`).

Жёсткая ошибка старта в commercial-режиме остаётся только для реальных проблем
доверия: отсутствие лицензии/ключа, неверная подпись, не-RSA алгоритм,
`notBefore` в будущем, несовпадение major-версии.

### Key ring для ротации ключей

Помимо основного `TIMEOFF_LICENSE_PUBLIC_KEY`, verifier принимает
`TIMEOFF_LICENSE_PUBLIC_KEYS` — JSON-словарь `keyId -> PEM`. Лицензия v2 с
полем `keyId` проверяется ключом из словаря; без `keyId` (или если id не
найден) — основным ключом. Это позволяет держать старый и новый ключ
одновременно на период ротации (см.
[license-key-compromise.md](license-key-compromise.md)).

### Отзыв лицензий в offline-инсталляциях

Отзыв выполняется подписанным списком CRL, не требует замены публичного ключа
и работает без сети. Выпустите список отдельным revocation-ключом:

```sh
npm run sign-revocation-list -- \
  --revoked LICENSE_ID_1,LICENSE_ID_2 \
  --expires 2027-01-31T23:59:59.000Z \
  --private-key-file revocation_private.pem \
  --base64
```

Передайте результат оператору и установите:

```sh
TIMEOFF_LICENSE_REVOCATION_LIST=PASTE_SIGNED_CRL
TIMEOFF_LICENSE_REVOCATION_PUBLIC_KEY=PASTE_REVOCATION_PUBLIC_KEY
```

Если отдельный публичный ключ не задан, используется основной лицензионный
ключ. Отдельный ключ рекомендуется: компрометация signing key и управление
отзывом остаются независимыми. CRL содержит `issuedAt`, `expiresAt` и массив
`revokedLicenseIds`. Неверная подпись, некорректный или просроченный CRL
считается ошибкой доверия и блокирует Premium. Отозванная лицензия отключает
Premium без остановки Community и без потери доступа к данным.

Оператор connected-инсталляции может обновлять ту же переменную/secret
автоматически. Air-gapped клиент импортирует новый подписанный CRL вручную до
истечения текущего списка.

### Алгоритм подписи

- **RSA-SHA256** (продакшн): канонический JSON payload подписывается приватным
  ключом через `crypto.sign('RSA-SHA256', ...)`. Проверка — через публичный ключ.
- **HMAC-SHA256** (только dev/test): канонический JSON подписывается общим секретом.

### Ключи

- **Приватный ключ** (`license_private.pem`) — используется только вендором для
  подписи. Никогда не передаётся клиенту и не коммитится в репозиторий.
- **Публичный ключ** (`license_public_key.pem`) — передаётся клиенту для проверки
  подписи в рантайме через `TIMEOFF_LICENSE_PUBLIC_KEY`.

## Тарифные планы

| План        | Описание | Фичи |
|-------------|----------|------|
| `starter`   | Базовое управление отпусками | (community defaults) |
| `pro`       | SSO + API + группы + календари | `sso_authentication`, `integration_api`, `employee_groups`, `work_calendars` |
| `enterprise`| Все фичи включая премиум-модули | Все из pro + `leave_start_reminders`, `time_balance`, `vacation_planning`, `cis_leave_presets`, `production_calendar`, `leave_orders`, `telegram_notifications` |

Параметр `--features` всегда переопределяет `--plan`. Список доступных фич:

```
ldap_authentication, sso_authentication, integration_api, employee_groups,
work_calendars, leave_start_reminders, time_balance, vacation_planning,
cis_leave_presets, production_calendar, leave_orders, telegram_notifications
```

## Генерация тестовой пары ключей

```bash
# Приватный ключ (хранить securely, НЕ коммитить)
openssl genpkey -algorithm RSA -out license_private.pem -pkeyopt rsa_keygen_bits:2048

# Публичный ключ (передаётся клиенту)
openssl rsa -in license_private.pem -pubout -out license_public_key.pem
```

## Создание лицензии

### С планом

```bash
node bin/sign_license.js \
  --customer "ООО Ромашка" \
  --plan pro \
  --private-key-file license_private.pem \
  --expires 2027-12-31
```

### С произвольным списком фич

```bash
node bin/sign_license.js \
  --customer "ООО Ромашка" \
  --features sso_authentication,integration_api,employee_groups \
  --private-key-file license_private.pem \
  --expires 2027-12-31
```

### В формате base64 (для вставки в .env)

```bash
node bin/sign_license.js \
  --customer "ООО Ромашка" \
  --plan enterprise \
  --private-key-file license_private.pem \
  --expires 2027-12-31 \
  --base64 > license.blob
```

### Сохранение в файл (`--out`)

```bash
node bin/license.js generate \
  --customer "ООО Ромашка" \
  --plan pro \
  --private-key-file license_private.pem \
  --expires 2027-12-31 \
  --out licenses/romashka-pro-2027.json
```

Лицензия записывается в указанный файл вместо stdout. Путь выводится в stderr.

### Регистр выданных лицензий (`--registry`)

Регистр — локальный JSON-файл вендора для учёта выпущенных лицензий. Это
ручная вендорская альтернатива License Portal
([docs/license-portal.md](license-portal.md)): без веб-UI и БД, только файл.

```bash
node bin/license.js generate \
  --customer "ООО Ромашка" \
  --plan enterprise \
  --private-key-file license_private.pem \
  --expires 2027-12-31 \
  --out licenses/romashka-enterprise.json \
  --registry licenses/registry.json
```

Каждая запись в регистре содержит:

| Поле          | Описание |
|---------------|----------|
| `customer`    | Имя клиента |
| `plan`        | Тарифный план |
| `features`    | Список фич |
| `expires`     | Дата истечения |
| `algorithm`   | Алгоритм подписи |
| `issuedAt`    | ISO-дата выпуска |
| `issuedBy`    | Имя системного пользователя |
| `payloadHash` | SHA-256 канонического payload (hex) |
| `licenseHash` | SHA-256 полного конверта (hex) |
| `outputFile`  | Путь к файлу лицензии (если `--out`) |

**Что НЕ хранится в регистре:** приватный ключ, подпись, полный blob лицензии.
Регистр — только метаданные для отслеживания.

```bash
# Просмотр содержимого регистра
node bin/license.js registry --registry licenses/registry.json
```

> **Важно:** файл регистра — операционная запись вендора. Никогда не передавайте
> его клиенту и не коммитьте в репозиторий.

## Просмотр лицензии

Не требует приватного ключа. Можно передать строку или путь к файлу:

```bash
# Из строки
node bin/license.js inspect '{"payload":{...},"algorithm":"RSA-SHA256","signature":"..."}'

# Из файла
node bin/license.js inspect license.json

# Из base64
node bin/license.js inspect "$(cat license.blob)"
```

Вывод содержит только безопасные поля: `customer`, `plan`, `features`, `expires`, `algorithm`.
Подпись и ключевой материал не отображаются.

## Проверка лицензии

```bash
# С публичным ключом из файла
node bin/license.js verify license.json --public-key-file license_public_key.pem

# С публичным ключом из переменной окружения
export TIMEOFF_LICENSE_PUBLIC_KEY="$(cat license_public_key.pem)"
node bin/license.js verify license.json
```

Результат: JSON с `valid: true` или ненулевой exit code с описанием ошибки.

## Список планов

```bash
node bin/license.js plans
```

## Запуск LeavePilot с лицензией в Docker Compose

### 1. Подготовка

```bash
# Сгенерируйте ключи (один раз)
openssl genpkey -algorithm RSA -out license_private.pem -pkeyopt rsa_keygen_bits:2048
openssl rsa -in license_private.pem -pubout -out license_public_key.pem

# Выпустите лицензию
node bin/sign_license.js \
  --customer "ООО Ромашка" \
  --plan enterprise \
  --private-key-file license_private.pem \
  --expires 2027-12-31 \
  --base64 > license.blob
```

### 2. Docker Compose

Используйте `docker-compose.commercial.yml`:

```bash
export TIMEOFF_LICENSE="$(cat license.blob)"
export TIMEOFF_LICENSE_PUBLIC_KEY="$(cat license_public_key.pem)"

docker compose -f docker-compose.yml -f docker-compose.commercial.yml up -d
```

Или добавьте в `.env`:

```env
TIMEOFF_LICENSE=<содержимое license.blob>
TIMEOFF_LICENSE_PUBLIC_KEY=<содержимое license_public_key.pem>
```

### 3. Проверка

```bash
# Проверить, что приложение запустилось с лицензией
docker compose logs app | grep -i license
```

## Устранение проблем

### `Commercial mode requires TIMEOFF_LICENSE`

Переменная `TIMEOFF_LICENSE` не задана или пуста. Проверьте `.env` или `docker-compose.yml`.

### `Commercial mode requires TIMEOFF_LICENSE_PUBLIC_KEY`

Переменная `TIMEOFF_LICENSE_PUBLIC_KEY` не задана. Убедитесь, что публичный ключ
передаётся в контейнер.

### `Commercial mode requires an RSA-SHA256 signed TIMEOFF_LICENSE`

Лицензия не является RSA-подписанной. Проверьте:
- Использовали ли `--private-key-file` (не `--secret`) при генерации
- Не повреждена ли строка лицензии при копировании

### `Commercial license is invalid: expired`

Срок действия лицензии истёк. Выпустите новую с будущей датой `--expires`.

### `Commercial license is invalid: invalid_signature`

Подпись не совпадает. Возможные причины:
- Публичный ключ не соответствует приватному, которым подписана лицензия
- Payload был изменён после подписи
- Лицензия была подписана другим ключом

### `Commercial license is invalid: invalid_format`

Строка лицензии повреждена или не является валидным JSON/base64. Проверьте:
- Нет ли переносов строк внутри значения
- Корректно ли закодирован base64

### Unknown feature warnings

Если в `features[]` указано имя, не зарегистрированное в `FEATURE_CATALOG`
(ни в core, ни в premium-модуле), фича просто не включится. Это не ошибка,
но проверьте опечатки.

## Предупреждения безопасности

> **Приватный ключ подписи (`license_private.pem`) НИКОГДА не должен:**
> - Коммититься в git (добавлен в `.gitignore`)
> - Передаваться клиенту
> - Храниться в Docker-образе
> - Передаваться через незашифрованные каналы
>
> Храните приватный ключ в защищённом хранилище (KMS, HSM, зашифрованный vault).

## Регистр и License Portal

License Portal — вендорская инфраструктура: он не входит в community-редакцию
и живёт в приватном репозитории вендора
([docs/license-portal.md](license-portal.md)). Регистр (`--registry` у
`bin/license.js`) остаётся ручным вендорским инструментом учёта: JSON-файл на
диске, без веб-UI и БД.

Формат записей регистра совместим с моделью данных портала (историческая
правда проектирования): и регистр, и портал ведут лицензии в едином формате
контракта — [LICENSE-CONTRACT.md](../LICENSE-CONTRACT.md).

## Дополнительные материалы

- [Архитектура лицензирования](licensing-architecture.md) — ADR с обоснованием модели
- [License Portal](license-portal.md) — портал как вендорская инфраструктура
- [Premium-модуль](premium-module.md) — установка и конфигурация
- [Docker Compose](docker-compose.md) — развёртывание
