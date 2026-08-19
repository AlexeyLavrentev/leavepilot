# Codebase Testing

_Last mapped: 2026-08-19_

## Test Framework

- **Mocha** — test runner (`t/` directory)
- **Chai** — assertions
- **nyc** — code coverage (`.nycrc.json`)
- **Puppeteer** — browser tests (screenshots, E2E)

## Test Structure

```
t/
├── lib/                   # Test helpers
│   └── skip_honesty.js    # Helper to skip honesty checks in tests
├── unit/                  # Unit tests
│   └── ...
├── integration/           # Integration tests
│   └── ...
└── ...
```

## Test Commands

```bash
npm test                           # Full test suite (bin/test.js)
npm run test:coverage              # Unit tests with coverage
mocha --recursive t/unit --timeout 10000  # Unit tests only
```

## License-Specific Tests

- `license-contract-fixtures/` — committed test keypairs and fixtures
- Test keys: `license-contract-fixtures/keys/`
- Test envelopes: valid, expired, grace, revoked, etc.
- `scripts/license_contract_check.js` — fixture/contract integrity check

## Mocking Patterns

- Premium module can be loaded in test mode
- `allowUnsignedLicenses()` returns `true` in test environment
- `allowUnlicensedFeatureOverrides()` returns `true` in non-production
- Frozen date/time in tests via `t/helpers.js` (D-08)

## Test Harness Notes

- `t/helpers.js` installs frozen Date BEFORE any portal module is required
- Tests use committed test keypairs — read only, never write there
- `FIXME` markers in `t/` are pinned-behavior flip points (D-07)
