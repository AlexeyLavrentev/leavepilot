# Codebase Conventions

_Last mapped: 2026-08-19_

## Code Style

- **2-space indentation**
- **Single quotes** for strings
- **Semicolons** required
- **Trailing commas** in multi-line literals
- **`const` by default**, `let` only for reassignment, **no `var`**
- **`'use strict';`** at top of every `.js` file
- **CommonJS** — `require()` / `module.exports`, no ESM
- **String concatenation with `+`**, not template literals (except some newer code)
- **No JSDoc**, no TODO/FIXME/HACK markers

## Module Patterns

### Factory Pattern
Every module exports `create*` functions that receive dependencies as arguments:
```js
const createSessionMiddleware = require('./lib/middleware/withSession');
const sessionMiddleware = createSessionMiddleware({ sequelizeDb: ... });
```

### Models Bag
Models passed as first argument to services:
```js
issueLicense(models, signingProvider, opts);
```

### Error Protocol
```js
throw Object.assign(new Error(msg), { code: 'VALIDATION_ERROR' });
```
Codes: `VALIDATION_ERROR` (400), `DUPLICATE`/`DUPLICATE_LICENSE` (409), `NOT_FOUND` (404), `RATE_LIMITED` (429)

### Transactions
Multi-row writes in `sequelize.transaction()` with `AuditLog` in the same transaction.

## Config Patterns

- All config through `lib/config.js` → nconf
- Env vars via `lib/env_resolver.js` with generation prefix system
- Feature flags are boot-time: restart to change
- No runtime config hot-reload

## Error Handling

- Routes: try/catch with appropriate HTTP status codes
- Services: throw with error codes
- Middleware: `next(err)` to error handler
- Global error handler: structured logging, no stack traces in production

## Logging

- **No `console.log` in services/routes/models**
- Logging only in `bin/` and `scripts/`
- Structured logger: `lib/middleware/request_logger.js`

## Security Patterns

- Passwords: scrypt with per-user salt
- Token comparisons: `crypto.timingSafeEqual` (never `===`)
- IPs: HMAC-hashed before storage
- Secrets never on CLI: `--password-env <VAR>` pattern
- CSRF: global middleware, timing-safe comparison
- Security headers: CSP, X-Frame-Options, HSTS

## UI Language

- Admin web UI: **Russian**
- Public trial messages: **Russian**
- Internal API/service messages: **English**
- Error messages: **English**
