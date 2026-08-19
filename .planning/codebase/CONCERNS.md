# Codebase Concerns

_Last mapped: 2026-08-19_

## Security Concerns — License Bypass Vectors

### Critical

1. **Public key NOT hardcoded** (`lib/features.js:105-106`)
   - `getLicensePublicKey()` reads from env `LICENSE_PUBLIC_KEY` or config
   - Anyone with env access can replace the public key and sign their own licenses
   - **Fix**: hardcode the production public key as fallback, env-only override for rotation

2. **`allowUnsignedLicenses()` in dev/test** (`lib/features.js:282-303`)
   - Returns `true` when `NODE_ENV=test` (default) or `NODE_ENV=development` with explicit opt-in
   - Allows `{"features":["all"]}` without any signature
   - **Risk**: if production misconfigured with wrong NODE_ENV

3. **`allowUnlicensedFeatureOverrides()` in dev** (`lib/features.js:723-739`)
   - Returns `true` in non-production environments
   - `FEATURE_SSO_AUTHENTICATION=true` in env activates feature without license
   - **Risk**: same NODE_ENV misconfiguration

4. **`allowConfigLicensedFeatures()` in dev** (`lib/features.js:741-757`)
   - Returns `true` in non-production
   - `licensed_features: [all]` in config activates all features without license
   - **Risk**: same NODE_ENV misconfiguration

### Medium

5. **No hardware binding** — license is portable
   - No `machineId`, `hardwareFingerprint`, `hostId` in payload or verification
   - License can be copied between servers freely
   - **Fix**: add machine fingerprint to payload, verify on load

6. **Revocation list optional** (`lib/features.js:186-245`)
   - `LEAVEPILOT_LICENSE_REVOCATION_LIST` not set by default
   - Cannot revoke compromised licenses without it
   - **Fix**: make revocation list mandatory for commercial mode, or add online revocation check

7. **No phone-home/heartbeat**
   - Portal doesn't know where licenses are used
   - No usage telemetry, no abuse detection
   - **Fix**: optional heartbeat to portal (privacy-respecting)

8. **Grace period client-controlled** (`lib/features.js:331-342`)
   - `getLicenseGraceDays()` reads from env/config, capped at 14
   - Client decides grace window, not server
   - **Mitigation**: cap is enforced (max 14), but operator can shorten

### Low

9. **Premium loader modifiable** (`lib/edition/premium_loader.js:99-101`)
   - `assertCommercialLicense()` called in node_modules path
   - File system access → can comment out the check
   - **Mitigation**: this requires root access to the server

10. **Commercial mode detection bypassable** (`lib/edition/commercial_mode.js:10-13`)
    - `.timeoff-commercial` marker file or `EDITION=commercial` env
    - Removing the marker + unsetting env → falls back to community mode
    - **Mitigation**: community mode still works, just no premium features

## Technical Debt

1. **Legacy `var` usage** — some older files still use `var` (e.g., `app.js:2`)
2. **moment.js** — still primary date library, should migrate to native Date/Temporal
3. **bluebird** — legacy Promise library, native Promise sufficient
4. **underscore** — legacy utility, could be replaced with native methods
5. **No TypeScript** — no type safety, harder to refactor
6. **Mixed module patterns** — some files use factory pattern, some use singletons

## Fragile Areas

1. **`lib/features.js`** — 881 lines, handles everything: parsing, verification, validation, feature gating, env reading
2. **`lib/edition/registry.js`** — central registry, if it breaks everything premium breaks
3. **`lib/env_resolver.js`** — generation prefix system, if broken all env reads fail
4. **`app.js` middleware order** — critical, changing order breaks auth/CSRF/session

## Performance Concerns

1. **License re-verification** — `getLicenseStatus()` called on every feature check, no caching (except OEM entitlement in `branding.js`)
2. **Synchronous file reads** — `commercial_mode.js` uses `fs.existsSync()` on every call
3. **No connection pooling config** — SQLite default, MySQL pooling not explicitly configured
