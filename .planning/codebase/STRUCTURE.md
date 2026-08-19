# Codebase Structure

_Last mapped: 2026-08-19_

## Directory Layout

```
leavepilot/                    # Main application (community + commercial)
├── app.js                     # Express app setup
├── bin/                       # CLI tools and entry points
│   ├── wwww                   # Server startup
│   ├── db_update.js           # DB migrations
│   ├── create_admin.js        # Admin creation
│   ├── sign_revocation_list.js# Revocation list tool
│   └── ...
├── config/                    # Configuration files
│   ├── app.json               # Main config
│   └── plan_presets.json      # Feature presets per plan
├── lib/                       # Core application code
│   ├── features.js            # ★ License verification & feature gating
│   ├── env_resolver.js        # ★ Env var generation resolver
│   ├── license_status_view.js # License status → UI bucket mapper
│   ├── branding.js            # White-label branding (gated by custom_branding)
│   ├── edition/               # ★ Edition system
│   │   ├── index.js           # EditionRegistry initialization
│   │   ├── registry.js        # EditionRegistry class
│   │   ├── premium_loader.js  # ★ Premium module loader
│   │   ├── community.js       # Community edition registration
│   │   └── commercial_mode.js # ★ Commercial edition detection
│   ├── licensing/             # Licensing enforcement
│   │   └── seat_limit.js      # Active user seat limit
│   ├── auth/                  # Authentication
│   ├── passport/              # Passport strategies
│   ├── sso/                   # SSO (OIDC/SAML)
│   ├── route/                 # Express routes
│   ├── model/                 # Sequelize models
│   ├── middleware/             # Express middleware
│   ├── view/                  # View helpers
│   ├── ui/                    # Static assets, UI utilities
│   ├── scheduler/             # Background jobs
│   ├── email.js               # Email sending
│   ├── config.js              # nconf configuration
│   └── ...
├── views/                     # Handlebars templates
│   ├── layouts/               # Layout templates
│   ├── partials/              # Partial templates
│   └── ...
├── locales/                   # i18n translations
├── migrations/                # Sequelize migrations
├── public/                    # Static assets (CSS, JS, images)
├── scss/                      # SASS source
├── t/                         # Tests
├── docs/                      # Documentation
├── license-contract-fixtures/ # ★ License contract test fixtures
├── LICENSE-CONTRACT.md        # ★ License contract specification
└── .timeoff-commercial        # ★ Commercial edition marker (presence = commercial)

timeoff-premium/               # Premium module (separate package)
├── index.js                   # ★ Entry point: register({registry, context})
├── core.js                    # Bridge to core app
├── check_core_contract.js     # Core API contract check
├── routes/                    # 19 premium route modules
├── models/                    # Premium Sequelize models
├── db/                        # Premium DB definitions
├── lib/                       # Premium business logic
│   ├── ...                    # SSO, telegram, connectors, etc.
├── views/                     # Premium Handlebars templates
├── partials/                  # Premium partials
├── email/                     # Premium email templates
├── locales/                   # Premium i18n
├── migrations/                # Premium migrations
├── public/js/                 # Premium client-side JS
└── test/                      # Premium tests
```

## Key Locations for License Work

| What | Where |
|---|---|
| License verification | `lib/features.js` |
| Env var resolution | `lib/env_resolver.js` |
| Commercial detection | `lib/edition/commercial_mode.js` |
| Premium loader | `lib/edition/premium_loader.js` |
| Feature catalog | `lib/features.js:10-22` |
| License status UI | `lib/license_status_view.js` |
| Seat limit | `lib/licensing/seat_limit.js` |
| License contract | `LICENSE-CONTRACT.md` |
| Test fixtures | `license-contract-fixtures/` |
| Revocation tool | `bin/sign_revocation_list.js` |
| Plan presets | `config/plan_presets.json` |

## Naming Conventions

- **Files**: `snake_case.js`
- **Directories**: lowercase, singular (`lib/route/`, not `lib/routes/`)
- **Functions**: camelCase
- **Constants**: `SCREAMING_SNAKE_CASE`
- **Config keys**: `snake_case`
- **Env vars**: `UPPER_SNAKE_CASE` with prefix (`LEAVEPILOT_*` or `TIMEOFF_*`)
- **Views**: `snake_case.hbs`
- **Migrations**: `NNN-description.js`
