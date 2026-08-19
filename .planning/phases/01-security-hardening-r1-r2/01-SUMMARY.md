# Phase 1 Summary: Security Hardening (R1, R2)

## What Was Built

### Plan 1.1: Hardcoded Public Key
- Added `HARDCODED_LICENSE_PUBLIC_KEY` constant in `lib/features.js` (production RSA public key)
- Modified `getLicensePublicKey()` to fall back to hardcoded key when env/config not set
- Env `LEAVEPILOT_LICENSE_PUBLIC_KEY` still works as override for key rotation
- Key ring (`LEAVEPILOT_LICENSE_PUBLIC_KEYS`) still works independently

### Plan 1.2: Machine Fingerprint
- Created `lib/machine_fingerprint.js` — deterministic SHA-256 fingerprint
- Components: hostname, MAC addresses, CPU model, platform, arch
- Graceful degradation: returns `null` on error, never throws
- 7 unit tests, all passing

## Tests

- 85 tests passing (features + license_cli + machine_fingerprint)
- 3 new tests for hardcoded key behavior
- 7 new tests for machine fingerprint
- 2 existing tests updated to reflect new hardcoded-key behavior

## Files Changed

| File | Action | Lines |
|---|---|---|
| `lib/features.js` | modified | +12 |
| `lib/machine_fingerprint.js` | new | 66 |
| `t/unit/features.js` | modified | +15 |
| `t/unit/machine_fingerprint.test.js` | new | 48 |
| `t/unit/license_cli.js` | modified | +6 |

## Known Issues

- 10 pre-existing test failures (branding, OEM gate) — not related to this phase
- Production public key is embedded — need to verify it's the correct key for production deployment

## Next Steps

- Phase 2: Hardware-Bound License (add `machineFingerprint` to payload, verify on load)
- Phase 3: License File Storage (can run in parallel with Phase 2)
