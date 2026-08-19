# Roadmap — License Activation System

_Last updated: 2026-08-19 after initialization_

## Phase 1: Security Hardening (R1, R2)

Укрепление фундамента: hardcoded public key + machine fingerprint.

**Deliverables:**
- Hardcoded public key в `lib/features.js`
- `lib/machine_fingerprint.js` — генерация fingerprint
- Тесты для обоих компонентов

**Dependencies:** None
**Estimated:** 1-2 plans

---

## Phase 2: Hardware-Bound License (R3, R7)

Machine fingerprint в payload лицензии + integrity check.

**Deliverables:**
- `machineFingerprint` поле в license payload
- Проверка fingerprint при верификации
- `moduleHash` в license payload
- Проверка integrity при загрузке premium
- Обновление `LICENSE-CONTRACT.md`
- Тесты

**Dependencies:** Phase 1 (fingerprint module)
**Estimated:** 2-3 plans

---

## Phase 3: License File Storage (R6)

Переход от env-only к файловому хранению лицензии.

**Deliverables:**
- `lib/license_storage.js` — чтение/запись license файла
- Config: `LEAVEPILOT_LICENSE_FILE` path
- Приоритет: env > file > none
- CLI: `leavepilot license status` — показать текущий статус
- Тесты

**Dependencies:** None (можно делать параллельно с Phase 1)
**Estimated:** 1-2 plans

---

## Phase 4: Online Activation (R4)

Онлайн-активация через портал.

**Deliverables:**
- Portal: `POST /api/v1/activate` endpoint
- Portal: activation token mechanism (one-time, TTL 24h)
- Client: activation flow (token → portal → license → save)
- CLI: `leavepilot activate <token>`
- Тесты на обеих сторонах

**Dependencies:** Phase 3 (license file storage), Portal GSD (отдельно)
**Estimated:** 3-4 plans

---

## Phase 5: Offline Activation (R5)

Офлайн-активация для air-gapped серверов.

**Deliverables:**
- CLI: `leavepilot activate --offline` — генерация request-файла
- Portal: `POST /api/v1/activate/offline` — приём request, выпуск лицензии
- Portal: `GET /api/v1/activate/offline/:id/download` — скачивание license-файла
- CLI: `leavepilot activate --license-file <path>` — загрузка license-файла
- Тесты E2E: полный offline флоу

**Dependencies:** Phase 3 (file storage), Phase 4 (portal endpoints)
**Estimated:** 2-3 plans

---

## Phase Summary

| Phase | Focus | Requirements | Dependencies |
|---|---|---|---|
| 1 | Security Hardening | R1, R2 | None |
| 2 | Hardware-Bound License | R3, R7 | Phase 1 |
| 3 | License File Storage | R6 | None |
| 4 | Online Activation | R4 | Phase 3, Portal |
| 5 | Offline Activation | R5 | Phase 3, Phase 4 |
