# Phase 2: Hardware-Bound License (R3, R7)

## Goal

Добавить hardware binding (machine fingerprint в payload, проверка при верификации) и integrity check (SHA-256 premium module в лицензии, проверка при загрузке).

## Requirements

- R3: Hardware-Bound License Payload — machineFingerprint в payload, проверка
- R7: Integrity Self-Check — SHA-256 premium module в лицензии, проверка

## Plan

### Plan 2.1: Machine Fingerprint in License Payload

**Wave:** 1
**Depends on:** Phase 1 (machine_fingerprint.js)
**Files modified:** `lib/features.js`, `t/unit/features.js`

**Tasks:**

#### Task 2.1.1: Add machineFingerprint to v2 payload validation

**Type:** implementation
**Read first:** `lib/features.js:382-416`

In `validateV2LicensePayload()`, add optional validation for `machineFingerprint`:

```js
if (payload.machineFingerprint !== undefined
    && (!isNonEmptyString(payload.machineFingerprint)
      || !/^[0-9a-f]{64}$/.test(payload.machineFingerprint))) {
  return 'invalid_machine_fingerprint';
}
```

This is optional — if absent, the license is not hardware-bound (backward compatible).

**Acceptance criteria:**
- [ ] `machineFingerprint` validated as 64-char hex string when present
- [ ] Absent `machineFingerprint` → no error (backward compatible)
- [ ] Invalid format → `invalid_machine_fingerprint` reason

#### Task 2.1.2: Verify machine fingerprint after signature verification

**Type:** implementation
**Read first:** `lib/features.js:526-604`

Add fingerprint verification in `verifyLicenseEnvelope()`, AFTER signature is verified but BEFORE returning success. Insert after the RSA-SHA256 signature check (line 574-581) and before `validateLicensePayload`:

```js
// After signature verification succeeds:
const fingerprintResult = verifyMachineFingerprint(payload);
if (fingerprintResult) {
  return {
    valid: false,
    reason: fingerprintResult,
    source,
    payload,
  };
}
```

New helper function `verifyMachineFingerprint(payload)`:
1. If `payload.machineFingerprint` is absent → return null (no check, backward compatible)
2. If present, call `generateFingerprint()` from `machine_fingerprint.js`
3. If fingerprint is null (collection failed) → return `fingerprint_collection_failed` (warn, don't block)
4. If fingerprint doesn't match → return `machine_mismatch`
5. If matches → return null (success)

**Acceptance criteria:**
- [ ] License without `machineFingerprint` → works on any server (backward compatible)
- [ ] License with matching fingerprint → works
- [ ] License with mismatched fingerprint → `valid: false, reason: machine_mismatch`
- [ ] If fingerprint collection fails → warning in console, license still valid (graceful degradation)
- [ ] Fingerprint check only runs after successful signature verification

#### Task 2.1.3: Add machineFingerprint to getLicenseStatus() output

**Type:** implementation
**Read first:** `lib/features.js:653-695`

Add `machineFingerprint` field to the status object:

```js
machineFingerprint: payload.machineFingerprint || null,
```

**Acceptance criteria:**
- [ ] `getLicenseStatus()` includes `machineFingerprint` field
- [ ] `null` when not present in payload

#### Task 2.1.4: Tests for hardware binding

**Type:** test
**Read first:** `t/unit/features.js`

Add tests:
1. License without machineFingerprint works on any server
2. License with correct machineFingerprint works
3. License with wrong machineFingerprint fails with `machine_mismatch`
4. License with invalid fingerprint format fails validation
5. getLicenseStatus() includes machineFingerprint field

**Acceptance criteria:**
- [ ] All new tests pass
- [ ] Existing tests not broken

---

### Plan 2.2: Premium Module Integrity Check

**Wave:** 1
**Depends on:** none
**Files modified:** `lib/edition/premium_loader.js`, `lib/module_integrity.js` (new), `t/unit/premium_loader.test.js`

**Tasks:**

#### Task 2.2.1: Create module_integrity.js

**Type:** implementation
**Read first:** `lib/machine_fingerprint.js` (for module style)

Create `lib/module_integrity.js`:

```js
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Compute SHA-256 hash of all .js files in a directory (sorted for determinism)
const computeModuleHash = (modulePath) => {
  try {
    const resolvedPath = path.resolve(modulePath);
    const files = [];
    
    const walkDir = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
          walkDir(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
          files.push(fullPath);
        }
      }
    };
    
    walkDir(resolvedPath);
    
    const hash = crypto.createHash('sha256');
    for (const file of files.sort()) {
      hash.update(fs.readFileSync(file));
    }
    
    return hash.digest('hex');
  } catch (_e) {
    return null;
  }
};

// Verify module hash matches expected
const verifyModuleHash = (modulePath, expectedHash) => {
  if (!expectedHash) return null; // no check needed
  const actualHash = computeModuleHash(modulePath);
  if (!actualHash) return 'integrity_check_failed';
  return actualHash === expectedHash ? null : 'integrity_mismatch';
};

module.exports = {
  computeModuleHash,
  verifyModuleHash,
};
```

**Acceptance criteria:**
- [ ] `computeModuleHash()` returns 64-char hex or null
- [ ] Deterministic: same files = same hash
- [ ] `verifyModuleHash()` returns null on match, error string on mismatch
- [ ] Skips node_modules and .git directories
- [ ] Sorts files for determinism

#### Task 2.2.2: Integrity check in premium_loader.js

**Type:** implementation
**Read first:** `lib/edition/premium_loader.js:62-118`

Add integrity check after `requirePremiumModule()` succeeds but before calling `premiumModule.register()`:

```js
const { verifyModuleHash } = require('../module_integrity');
const licensePayload = require('../features').readLicensePayload();
const moduleHash = licensePayload.moduleHash;

if (moduleHash) {
  const resolvedPath = path.resolve(process.cwd(), moduleName);
  const integrityResult = verifyModuleHash(resolvedPath, moduleHash);
  if (integrityResult) {
    effectiveLogger.error('Premium module integrity check failed: ' + integrityResult);
    return { loaded: false, moduleName, required, reason: integrityResult };
  }
}
```

**Acceptance criteria:**
- [ ] Integrity check runs only when `moduleHash` is in license payload
- [ ] If hash matches → premium loads normally
- [ ] If hash doesn't match → premium NOT loaded, error in log
- [ ] If `moduleHash` absent → no check (backward compatible)
- [ ] If hash computation fails → premium NOT loaded (fail closed)

#### Task 2.2.3: Tests for integrity check

**Type:** test

Create `t/unit/module_integrity.test.js`:
1. `computeModuleHash()` returns non-null string
2. Result is 64-char hex
3. Deterministic: two calls return same value
4. `verifyModuleHash()` returns null on match
5. `verifyModuleHash()` returns error on mismatch
6. `verifyModuleHash()` returns null when expectedHash is null

**Acceptance criteria:**
- [ ] All tests pass

---

## Verification

### must_haves

**truths:**
- `machineFingerprint` validated in v2 payload (optional field)
- Fingerprint verified after signature check in `verifyLicenseEnvelope()`
- Mismatched fingerprint → `valid: false, reason: machine_mismatch`
- Missing fingerprint → backward compatible (no check)
- `module_integrity.js` exports `computeModuleHash()` and `verifyModuleHash()`
- Integrity check in `premium_loader.js` when `moduleHash` present
- All existing tests still pass
- New tests pass

**prohibitions:**
- No `var` usage
- No new dependencies
- No changes to portal code
- No breaking backward compatibility (missing fingerprint/moduleHash = no check)

## Artifacts this phase produces

- `lib/features.js` — modified (fingerprint validation + verification)
- `lib/module_integrity.js` — new module
- `lib/edition/premium_loader.js` — modified (integrity check)
- `t/unit/features.js` — modified (new tests)
- `t/unit/module_integrity.test.js` — new test file
