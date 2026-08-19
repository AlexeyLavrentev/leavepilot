# Requirements — License Activation System

_Last updated: 2026-08-19 after initialization_

## v1 Requirements

### R1: Hardcoded Public Key

**Priority**: Critical
**Category**: Security

Вшить production public key в клиентский код как fallback. Env-override только для key rotation.

- [ ] Hardcoded RSA public key в `lib/features.js` как дефолт
- [ ] Env `LEAVEPILOT_LICENSE_PUBLIC_KEY` работает как override (для ротации)
- [ ] Key ring `LEAVEPILOT_LICENSE_PUBLIC_KEYS` продолжает работать
- [ ] В commercial mode: если ни ключ, ни key ring не заданы — используется hardcoded
- [ ] Тесты: подпись с hardcoded ключом проходит верификацию

### R2: Machine Fingerprint

**Priority**: Critical
**Category**: Security

Генерировать уникальный fingerprint сервера для hardware binding лицензии.

- [ ] Fingerprint на основе: hostname, MAC-addresses, CPU ID, disk serial
- [ ] `lib/machine_fingerprint.js` — модуль генерации fingerprint
- [ ] Deterministic: один и тот же hardware = один и тот же fingerprint
- [ ] Graceful degradation: если нельзя собрать — warning, не блокировать
- [ ] Формат: SHA-256 hash от собранных компонентов

### R3: Hardware-Bound License Payload

**Priority**: Critical
**Category**: Security

Добавить machine fingerprint в payload лицензии и проверять при верификации.

- [ ] Новое поле `machineFingerprint` в license payload (schema v2 extension)
- [ ] Portal добавляет fingerprint при выпуске лицензии
- [ ] Клиент проверяет fingerprint при `getLicenseStatus()`
- [ ] Если fingerprint не совпадает → `valid: false, reason: 'machine_mismatch'`
- [ ] Если fingerprint отсутствует в payload → backward compatible (старые лицензии работают)
- [ ] Обновление `LICENSE-CONTRACT.md` с новым полем

### R4: Online Activation Flow

**Priority**: High
**Category**: UX

Приложение активируется онлайн через портал.

- [ ] Portal endpoint: `POST /api/v1/activate` (token + machineId → signed license)
- [ ] Activation token: one-time, привязан к customer + machineId, TTL 24h
- [ ] Клиент: `POST /api/v1/licenses/activate` с activation token
- [ ] Клиент сохраняет лицензию в файл (не в env)
- [ ] Клиент читает лицензию из файла при старте (fallback на env)
- [ ] CLI tool: `leavepilot activate <token>` — удобная активация

### R5: Offline Activation Flow

**Priority**: High
**Category**: UX

Активация на air-gapped серверах (KOMPAS-3D модель).

- [ ] Шаг 1: На air-gapped машине — `leavepilot activate --offline` генерирует request-файл
  - Request содержит: machine fingerprint, customer info, timestamp
  - Формат: JSON, подпись не требуется (это запрос, не лицензия)
- [ ] Шаг 2: На машине с интернетом — загрузить request-файл в портал
  - Portal: `POST /api/v1/activate/offline` — принимает request, генерирует лицензию
  - Portal: `GET /api/v1/activate/offline/:id/download` — скачать license-файл
- [ ] Шаг 3: На air-gapped машине — `leavepilot activate --license-file <path>`
  - Загружает license-файл, проверяет подпись и fingerprint
  - Сохраняет в локальное хранилище
- [ ] Request-файл не содержит секретов, можно передавать открыто
- [ ] License-файл подписан RSA, невозможно подделать

### R6: License File Storage

**Priority**: High
**Category**: Architecture

Хранить лицензию в файле, а не только в env.

- [ ] Путь: `data/license.json` (или конфигурируемый через `LEAVEPILOT_LICENSE_FILE`)
- [ ] При старте: читать из файла, fallback на env
- [ ] При активации: сохранять в файл
- [ ] Файл содержит полный envelope: `{ payload, algorithm, signature }`
- [ ] Env `LEAVEPILOT_LICENSE` имеет приоритет над файлом (для контейнеров)

### R7: Integrity Self-Check

**Priority**: Medium
**Category**: Security

Premium module проверяет свою целостность при загрузке.

- [ ] SHA-256 hash premium module файлов в license payload (`moduleHash`)
- [ ] При загрузке premium module — проверка hash
- [ ] Если hash не совпадает → premium НЕ загружается, warning в лог
- [ ] Если `moduleHash` отсутствует в payload → backward compatible
- [ ] Portal вычисляет hash при выпуске лицензии

## v2 Requirements (Deferred)

- [ ] Heartbeat/phone-home to portal — privacy concerns
- [ ] Telemetry/usage statistics
- [ ] License renewal automation
- [ ] Multi-server license pools
- [ ] Graceful license migration between servers

## Acceptance Criteria

### AC1: Online Activation Works
```
Given: valid activation token
When: user runs `leavepilot activate <token>`
Then: license is downloaded, verified, saved, premium features activate
```

### AC2: Offline Activation Works
```
Given: air-gapped server
When: user generates request, transfers to online machine, gets license, transfers back
Then: license is loaded, verified against machine fingerprint, premium features activate
```

### AC3: License Cannot Be Copied
```
Given: license activated on Server A
When: same license file copied to Server B
Then: activation fails with 'machine_mismatch'
```

### AC4: Public Key Cannot Be Substituted
```
Given: attacker has env access
When: replaces LEAVEPILOT_LICENSE_PUBLIC_KEY with own key, signs own license
Then: hardcoded key is used, signature verification fails
```

### AC5: Backward Compatible
```
Given: existing license without machineFingerprint
When: loaded on any server
Then: works normally (no hardware binding check)
```
