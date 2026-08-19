# Codebase Stack

_Last mapped: 2026-08-19_

## Languages & Runtime

- **Node.js** >=22.12.0 <23 (`.node-version`, `package.json:engines`)
- **CommonJS** modules (`require`/`module.exports`), no ESM
- **No TypeScript** — pure JavaScript
- **Strict mode** — `'use strict';` at top of every `.js` file

## Frameworks & Libraries

| Category | Library | Version | Notes |
|---|---|---|---|
| HTTP | Express | ^5.2.1 | Express 5, not 4 |
| Templates | express-handlebars | ^9.0.1 | `.hbs` views |
| ORM | Sequelize | ^6.37.7 | Models in `lib/model/` |
| Database | sqlite3 | ^6.0.1 | Default; mysql2 ^3.23.2 supported |
| Auth | Passport | ^0.7.0 | Local + HTTP Bearer strategies |
| Sessions | express-session + connect-session-sequelize | | DB-backed sessions |
| i18n | i18next | ^26.3.6 | `locales/` directory |
| Validation | Joi | ^18.2.3 | |
| Email | Nodemailer | ^9.0.3 | |
| Redis | redis | ^6.2.0 | Optional, for session store |
| LDAP | ldapauth-fork | ^6.1.0 | Enterprise SSO |
| Config | nconf | ^0.13.0 | Env + file config |
| Dates | moment + moment-timezone | | Legacy, still primary |
| Compression | compression | ^1.8.1 | |
| Migrations | umzug | ^3.8.3 | Sequelize migrations |

## Dependencies to Note

- **No devDependencies** in portal project (leavepilot-portal has zero devDeps policy)
- Client project (`leavepilot`) does have devDeps: mocha, chai, nyc, puppeteer, sass
- `bluebird` — legacy Promise library, still imported in some places
- `underscore` — legacy utility library

## Configuration System

**Config chain** (`lib/config.js`): nconf-based, priority:
1. Command-line arguments
2. Environment variables
3. Config file (`config/*.json`)

**Env resolver** (`lib/env_resolver.js`): generation-based prefix system:
- `LEAVEPILOT_*` (canonical, generation 2)
- `TIMEOFF_*` (deprecated compat shim, generation 1, warned at boot)
- `BRAND_*` / `APPLICATION_*` (separate, branding only)

**Key config files:**
- `config/app.json` — main app config
- `config/plan_presets.json` — feature presets per plan (starter/pro/enterprise)
- `docker-compose*.yml` — deployment variants

## License & Edition System

**Edition detection** (`lib/edition/commercial_mode.js`):
- Marker file `.timeoff-commercial` exists → commercial
- Or env `EDITION=commercial`

**Feature catalog** (`lib/features.js:10-22`):
```
ldap_authentication:  { defaultEnabled: true }
sso_authentication:   { defaultEnabled: false }
integration_api:      { defaultEnabled: false }
employee_groups:      { defaultEnabled: false }
work_calendars:       { defaultEnabled: false }
leave_start_reminders:{ defaultEnabled: true }
custom_branding:      { defaultEnabled: false }
```

**Premium module** (`timeoff-premium/`) registers 13+ additional features.

**License verification** (`lib/features.js`): RSA-SHA256 or HMAC-SHA256, env-based keys.

## Build & Deploy

- **Docker**: multi-stage Dockerfile
- **No bundler**: no webpack, no vite, no esbuild
- **SASS**: `scss/main.scss` → `public/css/style.css` (manual compile)
- **Static assets**: content-addressed URLs via `lib/ui/static_assets.js`
