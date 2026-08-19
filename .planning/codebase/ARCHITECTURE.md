# Codebase Architecture

_Last mapped: 2026-08-19_

## Overall Pattern

**MVC** with Express 5 middleware pipeline. Server-rendered Handlebars templates, no SPA.

```
Request → Middleware → Route → Service/Model → Response
                ↓
         Passport (auth)
         Session (DB-backed)
         CSRF (global)
         Features (license gate)
         Edition (premium registration)
```

## Layer Boundaries

### Routes (`lib/route/`)
- HTTP handlers, thin controllers
- Call into models/services directly
- Premium routes: `timeoff-premium/routes/` (19 route modules)

### Models (`lib/model/`)
- Sequelize models, central export in `lib/model/db.js`
- Associations defined in `lib/model/db.js`
- Premium models: `timeoff-premium/models/`

### Services
- Business logic co-located with routes (no separate `services/` in client)
- Premium services: `timeoff-premium/lib/`

### Views (`views/`)
- Handlebars `.hbs` templates
- Layouts: `views/layouts/main.hbs`
- Partials: `views/partials/` + `timeoff-premium/partials/`
- Premium views: `timeoff-premium/views/`

## Key Abstractions

### EditionRegistry (`lib/edition/registry.js`)
Central registry for premium module contributions:
- Routes, navigation items, view paths, partial paths
- Email template paths, DB model paths, migrations
- Schedulers, notification providers, diagnostics
- Leave event dispatcher, leave validator
- SSO provider, supervised department provider

### Features (`lib/features.js`)
License-gated feature system:
- `FEATURE_CATALOG` — registered features with defaults
- `isEnabled(name)` — check if feature active
- `requireFeature(name)` — Express middleware gate
- `getLicenseStatus()` — full license verification
- `assertCommercialLicense()` — startup gate for commercial mode

### Premium Loader (`lib/edition/premium_loader.js`)
- Resolves premium module name from env/config
- `require()` the module
- Calls `assertCommercialLicense()` if commercial edition
- Calls `premiumModule.register({registry, context})`

### Env Resolver (`lib/env_resolver.js`)
- Generation-based env var resolution
- `LEAVEPILOT_*` (canonical) → `TIMEOFF_*` (deprecated compat)
- Single read site for all env vars with these prefixes

## Data Flow

### License Verification Flow
```
env LEAVEPILOT_LICENSE
  → parseLicense() — JSON or base64
  → verifyLicenseEnvelope() — RSA-SHA256 or HMAC-SHA256
    → getLicensePublicKeyForPayload() — key ring lookup
    → crypto.verify('RSA-SHA256', ...)
  → validateLicensePayload() — schema, expiry, version
  → verifyRevocationListForLicense() — optional revocation check
  → getLicenseStatus() — final status object
```

### Premium Module Loading Flow
```
app.js → edition.initialize(editionContext)
  → premium_loader.load()
    → resolveModuleName() — from env/config
    → require(moduleName) — load premium module
    → assertCommercialLicense() — verify license
    → premiumModule.register({registry, context})
      → registry.registerRoutes(...)
      → registry.registerNavigationItems(...)
      → etc.
```

### Request Auth Flow
```
Request → session middleware → passport.initialize()
  → passport.session() → load user from session
  → route handler → features.requireFeature('x')
    → isEnabled() → getLicenseStatus() → allow/deny
```

## Entry Points

| File | Purpose |
|---|---|
| `app.js` | Express app setup, middleware chain, edition init |
| `bin/wwww` | Server startup (calls `app.js`) |
| `bin/db_update.js` | Database migrations |
| `bin/create_admin.js` | Admin user creation |
| `bin/sign_revocation_list.js` | Revocation list signing tool |

## Critical Code Paths

### `lib/features.js` — The License Gate
- `assertCommercialLicense()` — called at premium module load
- `getLicenseStatus()` — called on every feature check
- `verifyLicenseEnvelope()` — RSA/HMAC signature verification
- `validateLicensePayload()` — schema and expiry validation

### `lib/edition/premium_loader.js` — Premium Bootstrap
- `load()` — loads and registers premium module
- `createPremiumContext()` — bridges core to premium

### `lib/edition/commercial_mode.js` — Edition Detection
- `isCommercialEdition()` — marker file or env var check
