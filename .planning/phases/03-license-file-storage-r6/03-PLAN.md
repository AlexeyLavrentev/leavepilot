# Phase 3: License File Storage (R6)

## Goal

Переход от env-only к файловому хранению лицензии. Приоритет: env > file > config > none. Файл создаётся при активации и читается при старте.

## Requirements

- R6: License File Storage — чтение/запись license файла

## Plan

### Plan 3.1: License File Storage Module

**Wave:** 1
**Depends on:** none
**Files modified:** `lib/license_storage.js` (new), `lib/features.js`, `t/unit/license_storage.test.js` (new)

**Tasks:**

#### Task 3.1.1: Create license_storage.js module

**Type:** implementation
**Read first:** `lib/env_resolver.js` (module style), `lib/features.js:320-341` (licenseRawValue)

Create `lib/license_storage.js`:

```js
'use strict';

const fs = require('fs');
const path = require('path');
const envResolver = require('./env_resolver');
const config = require('./config');

const DEFAULT_LICENSE_FILE = 'data/license.json';

const getLicenseFilePath = () =>
  envResolver.resolve('LICENSE_FILE')
  || config.get('license_file')
  || DEFAULT_LICENSE_FILE;

// Read license from file. Returns { raw, source } or { raw: null, source: 'none' }.
const readLicenseFile = () => {
  const filePath = getLicenseFilePath();
  const resolvedPath = path.resolve(filePath);
  
  try {
    const content = fs.readFileSync(resolvedPath, 'utf8');
    if (!content || !content.trim()) {
      return { raw: null, source: 'none' };
    }
    return { raw: content.trim(), source: 'file' };
  } catch (_e) {
    return { raw: null, source: 'none' };
  }
};

// Write license to file. Returns true on success, false on error.
const writeLicenseFile = (licenseJson) => {
  const filePath = getLicenseFilePath();
  const resolvedPath = path.resolve(filePath);
  
  try {
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(resolvedPath, typeof licenseJson === 'string' ? licenseJson : JSON.stringify(licenseJson, null, 2), 'utf8');
    return true;
  } catch (_e) {
    return false;
  }
};

module.exports = {
  getLicenseFilePath,
  readLicenseFile,
  writeLicenseFile,
};
```

**Acceptance criteria:**
- [ ] `readLicenseFile()` returns `{ raw, source }` or `{ raw: null, source: 'none' }`
- [ ] `writeLicenseFile()` creates parent directories if needed
- [ ] File path configurable via `LEAVEPILOT_LICENSE_FILE` env or `license_file` config
- [ ] Default path: `data/license.json`
- [ ] `'use strict';` at top, CommonJS

#### Task 3.1.2: Integrate file storage into licenseRawValue()

**Type:** implementation
**Read first:** `lib/features.js:320-341`

Modify `licenseRawValue()` to add file as a source between env and config:

```js
const licenseRawValue = () => {
  // 1. Env has highest priority (for containers)
  if (envResolver.resolve('LICENSE')) {
    return { raw: envResolver.resolve('LICENSE'), source: 'env' };
  }

  // 2. File storage (for persistent deployments)
  const fileResult = readLicenseFile();
  if (fileResult.raw) {
    return fileResult;
  }

  // 3. Config (legacy)
  const configuredLicense = config.get('license');
  if (configuredLicense) {
    return { raw: configuredLicense, source: 'config' };
  }

  return { raw: null, source: 'none' };
};
```

**Acceptance criteria:**
- [ ] Priority: env > file > config > none
- [ ] Env still has highest priority (for containers)
- [ ] File is checked before config
- [ ] Source correctly reported as 'file' when read from file

#### Task 3.1.3: Add license status command

**Type:** implementation
**Read first:** `bin/` (for CLI style)

Add `license_file` field to `getLicenseStatus()` output:

```js
licenseFile: getLicenseFilePath(),
```

This lets the UI show which file the license was read from.

**Acceptance criteria:**
- [ ] `getLicenseStatus()` includes `licenseFile` field
- [ ] Shows configured file path

#### Task 3.1.4: Tests for license file storage

**Type:** test
**Read first:** `t/unit/features.js` (test style)

Create `t/unit/license_storage.test.js`:
1. `readLicenseFile()` returns `{ raw: null, source: 'none' }` when no file
2. `writeLicenseFile()` creates file, `readLicenseFile()` reads it back
3. `writeLicenseFile()` creates parent directories
4. Priority: env > file > config
5. `getLicenseFilePath()` returns configured path

**Acceptance criteria:**
- [ ] All tests pass
- [ ] Tests clean up after themselves (temp files)

---

## Verification

### must_haves

**truths:**
- `lib/license_storage.js` exports `readLicenseFile()`, `writeLicenseFile()`, `getLicenseFilePath()`
- `licenseRawValue()` reads from file when env not set
- Priority: env > file > config > none
- `getLicenseStatus()` includes `licenseFile` field
- All existing tests still pass
- New tests pass

**prohibitions:**
- No `var` usage
- No new dependencies
- No breaking backward compatibility
- No changes to license verification logic (only reading source)

## Artifacts this phase produces

- `lib/license_storage.js` — new module
- `lib/features.js` — modified (file reading in licenseRawValue)
- `t/unit/license_storage.test.js` — new test file
