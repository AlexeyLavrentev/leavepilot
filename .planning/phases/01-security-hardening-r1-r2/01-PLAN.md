# Phase 1: Security Hardening (R1, R2)

## Goal

Укрепить фундамент лицензирования: hardcoded public key для защиты от подмены ключа + модуль генерации machine fingerprint для hardware binding.

## Requirements

- R1: Hardcoded Public Key — вшить production public key как fallback
- R2: Machine Fingerprint — deterministic fingerprint сервера

## Plan

### Plan 1.1: Hardcoded Public Key

**Wave:** 1
**Depends on:** none
**Files modified:** `lib/features.js`, `t/unit/features.test.js`

**Tasks:**

#### Task 1.1.1: Add hardcoded public key constant

**Type:** implementation
**Read first:** `lib/features.js:105-137`

Add hardcoded RSA public key PEM as a module-level constant in `lib/features.js`:

```js
const HARDCODED_LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
<production public key here>
-----END PUBLIC KEY-----`;
```

This key is the production signing key. It serves as the trust root — env overrides are only for key rotation.

**Acceptance criteria:**
- [ ] Constant `HARDCODED_LICENSE_PUBLIC_KEY` defined at module level
- [ ] PEM format is valid (BEGIN/END markers, base64 content)
- [ ] Not exported (internal to features.js)

#### Task 1.1.2: Modify getLicensePublicKey() to use hardcoded fallback

**Type:** implementation
**Read first:** `lib/features.js:105-106`

Change `getLicensePublicKey()` to:
1. Check env `LEAVEPILOT_LICENSE_PUBLIC_KEY` first (override for rotation)
2. If not set, use `HARDCODED_LICENSE_PUBLIC_KEY` as fallback
3. Log a warning once if using hardcoded key (for operators to know they should set the env var for rotation)

```js
const getLicensePublicKey = () => {
  const envKey = envResolver.resolve('LICENSE_PUBLIC_KEY');
  if (envKey) return envKey;
  return HARDCODED_LICENSE_PUBLIC_KEY;
};
```

**Acceptance criteria:**
- [ ] Env key takes precedence when set
- [ ] Hardcoded key used when env not set
- [ ] Key ring (`LICENSE_PUBLIC_KEYS`) still works independently
- [ ] Existing tests pass

#### Task 1.1.3: Tests for hardcoded key

**Type:** test
**Read first:** `t/unit/features.test.js`

Add tests:
1. License signed with hardcoded key verifies when no env key set
2. License signed with env key verifies when env key is set (override)
3. License signed with wrong key fails verification
4. Key ring still works alongside hardcoded key

**Acceptance criteria:**
- [ ] All new tests pass
- [ ] Existing tests not broken

---

### Plan 1.2: Machine Fingerprint Module

**Wave:** 1
**Depends on:** none
**Files modified:** `lib/machine_fingerprint.js` (new), `t/unit/machine_fingerprint.test.js` (new)

**Tasks:**

#### Task 1.2.1: Create machine_fingerprint.js module

**Type:** implementation
**Read first:** `lib/env_resolver.js` (for module style reference)

Create `lib/machine_fingerprint.js` with:

```js
'use strict';

const crypto = require('crypto');
const os = require('os');

const collectComponents = () => {
  const components = [];
  
  // Hostname
  components.push('hostname:' + os.hostname());
  
  // MAC addresses (sorted for determinism)
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces).sort()) {
    for (const iface of interfaces[name]) {
      if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
        components.push('mac:' + iface.mac);
      }
    }
  }
  
  // CPU model
  const cpus = os.cpus();
  if (cpus.length > 0) {
    components.push('cpu:' + cpus[0].model);
  }
  
  // Platform + arch
  components.push('platform:' + os.platform());
  components.push('arch:' + os.arch());
  
  return components;
};

const generateFingerprint = () => {
  try {
    const components = collectComponents();
    const hash = crypto.createHash('sha256');
    hash.update(components.join('|'));
    return hash.digest('hex');
  } catch (error) {
    return null;
  }
};

module.exports = {
  collectComponents,
  generateFingerprint,
};
```

**Acceptance criteria:**
- [ ] Module exports `generateFingerprint()` and `collectComponents()`
- [ ] Returns 64-char hex string (SHA-256)
- [ ] Deterministic: same machine = same fingerprint
- [ ] Graceful degradation: returns `null` on error, not throw
- [ ] `'use strict';` at top
- [ ] CommonJS (`module.exports`)

#### Task 1.2.2: Tests for machine fingerprint

**Type:** test
**Read first:** `t/unit/` (for test style reference)

Create `t/unit/machine_fingerprint.test.js`:
1. `generateFingerprint()` returns non-null string
2. Result is 64-char hex (SHA-256)
3. Deterministic: two calls return same value
4. `collectComponents()` returns non-empty array
5. Each component has `key:value` format

**Acceptance criteria:**
- [ ] All tests pass
- [ ] Tests follow existing mocha/chai style

---

## Verification

### must_haves

**truths:**
- `HARDCODED_LICENSE_PUBLIC_KEY` constant exists in `lib/features.js`
- `getLicensePublicKey()` returns hardcoded key when env not set
- `getLicensePublicKey()` returns env key when set (override)
- `lib/machine_fingerprint.js` exports `generateFingerprint()`
- `generateFingerprint()` returns deterministic SHA-256 hex string
- All existing tests still pass
- New tests pass

**prohibitions:**
- No `var` usage — `const`/`let` only
- No template literals (except where existing code uses them)
- No new dependencies
- No changes to `LICENSE-CONTRACT.md` (that's Phase 2)
- No changes to license payload format (that's Phase 2)
- No changes to portal code (separate GSD)

## Artifacts this phase produces

- `lib/features.js` — modified (hardcoded key)
- `lib/machine_fingerprint.js` — new module
- `t/unit/features.test.js` — modified (new tests)
- `t/unit/machine_fingerprint.test.js` — new test file
