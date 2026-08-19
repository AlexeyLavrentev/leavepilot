# LeavePilot License Activation System

## What This Is

Улучшение системы активации лицензий LeavePilot: переход от ручного копирования env-переменных к онлайн-активации с hardware binding, hardcoded public key для защиты от подмены, и офлайн-активация для air-gapped серверов. Затрагивает клиентскую часть (leavepilot) и портал (leavepilot-portal).

## Core Value

Лицензия должна быть защищена от обхода и удобна в активации — одно без другого бессмысленно.

## Business Context

- **Customer**: B2B клиенты LeavePilot, self-hosted部署
- **Revenue model**: Платные лицензии (pro/enterprise) через портал
- **Success metric**: Кол-во успешных активаций без обращений в поддержку

## Requirements

### Validated

- ✓ RSA-SHA256 подпись лицензий — работает
- ✓ Feature gating по лицензии — работает
- ✓ Grace period 14 дней — работает
- ✓ Premium module loading — работает
- ✓ Seat limit enforcement — работает
- ✓ Revocation list (optional) — работает
- ✓ Trial mechanism (portal) — работает

### Active

- [ ] Online activation: приложение стучится на портал, получает подписанную лицензию
- [ ] Hardware binding: machine fingerprint в payload лицензии, проверка при верификации
- [ ] Hardcoded public key: fallback на захардкоженный ключ, env-override только для ротации
- [ ] Offline activation: файл активации генерируется на машине с интернетом, переносится на air-gapped
- [ ] Activation token: one-time token для активации, привязан к customer + machineId
- [ ] Portal API: `POST /api/v1/activate` endpoint для онлайн-активации
- [ ] CLI activation tool: `leavepilot activate <token>` для удобной активации
- [ ] Integrity check: SHA-256 premium module в лицензии, проверка при загрузке

### Out of Scope

- Heartbeat/phone-home — privacy concerns, не обязательно для v1
- Telemetry/usage stats — отдельная тема
- License renewal automation — пока ручное продление через портал
- Multi-server license pools — одна лицензия = один сервер (hardware binding)

## Context

### Текущая архитектура лицензирования

**Клиент** (`leavepilot`):
- `lib/features.js` — центральный файл: парсинг, верификация, валидация, feature gating
- `lib/env_resolver.js` — чтение env-переменных с поколенческим префиксом (LEAVEPILOT_* / TIMEOFF_*)
- `lib/edition/premium_loader.js` — загрузка premium модуля, вызов `assertCommercialLicense()`
- `lib/edition/commercial_mode.js` — определение коммерческой редакции
- `lib/license_status_view.js` — маппинг статуса в UI-бакеты
- `lib/licensing/seat_limit.js` — лимит активных пользователей

**Портал** (`leavepilot-portal`):
- `services/license_service.js` — создание лицензий
- `signing/` — RSA подписывание (File, External, KMS провайдеры)
- `api/router.js` — REST API
- `trial/` — self-service trial mechanism

### Известные лазейки (из анализа)

1. Public key НЕ захардкожен — замена ключа = полный обход
2. `allowUnsignedLicenses()` true в dev/test
3. `allowUnlicensedFeatureOverrides()` true в dev
4. `allowConfigLicensedFeatures()` true в dev
5. Нет hardware binding — лицензия portable
6. Revocation list опциональна
7. Нет phone-home/heartbeat
8. Premium loader модифицируем в node_modules

### Референс: KOMPAS-3D / КАСКАД ЦИФРА offline activation

Флоу:
1. На air-gapped машине: генерируется request-файл (machine fingerprint)
2. На машине с интернетом: request-файл загружается в портал, портал генерирует license-файл
3. На air-gapped машине: license-файл загружается, активация завершена

## Constraints

- **Compatibility**: Node.js >=22.12.0 <23, CommonJS only
- **Security**: public key должен быть захардкожен в клиенте, env-override только для ротации
- **UX**: активация должна быть проще, чем текущее копирование env-переменных
- **Offline**: должна работать активация без интернета на целевом сервере
- **Portal**: изменения в портале — отдельный GSD, не в этом проекте

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Hardware binding via machine fingerprint | Prevents license portability | — Pending |
| Hardcoded public key with env override | Prevents key substitution attack | — Pending |
| Offline activation via request/response files | KOMPAS-3D model, proven in industry | — Pending |
| One-time activation tokens | Prevents token reuse | — Pending |
| SHA-256 integrity check for premium module | Prevents loader modification | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-08-19 after initialization*
