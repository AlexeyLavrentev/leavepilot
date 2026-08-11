# Community and Commercial Builds

This project now has two delivery modes:

- Community build: source-available core only.
- Commercial build: source-available core plus a private premium module.

Use `docs/release-checklist.md` before publishing either build.

## Repositories

Core application:

```text
/path/to/timeoff
```

Private premium module:

```text
/path/to/timeoff-premium
```

The community repository must not contain premium implementation files. Premium
routes, models, migrations, views, email templates, translations, and helpers
live in the private module.

## Community Image

Build and run the regular community image:

```sh
docker compose up --build
```

In this mode:

- `TIMEOFF_PREMIUM_MODULE` is empty.
- Premium DB models are not loaded.
- Premium routes are not registered.
- Premium migrations are not applied.
- Premium navigation items are hidden.
- LDAP remains available.
- OIDC/SAML, employee groups, work calendars, leave reminders, the integration
  API, time balance, and vacation planning remain disabled.

## Commercial Image With Docker COPY

The commercial Docker target copies the private premium module into the image
through a BuildKit named context.

Build and run:

```sh
TIMEOFF_PREMIUM_MODULE_HOST_PATH=/path/to/timeoff-premium \
TIMEOFF_LICENSE=PASTE_BASE64_LICENSE_HERE \
TIMEOFF_LICENSE_PUBLIC_KEY=PASTE_PUBLIC_KEY_WITH_ESCAPED_NEWLINES_HERE \
docker compose -f docker-compose.yml -f docker-compose.commercial.yml up --build
```

The commercial override:

- builds Docker target `commercial`;
- copies the premium module to `/opt/timeoff-premium`;
- sets `TIMEOFF_PREMIUM_MODULE=/opt/timeoff-premium`;
- requires `TIMEOFF_LICENSE`;
- requires `TIMEOFF_LICENSE_PUBLIC_KEY`.

Use this mode for production-like self-hosted commercial delivery.

Commercial startup fails instead of falling back to Community when:

- `TIMEOFF_PREMIUM_MODULE` is missing or cannot be loaded;
- `TIMEOFF_LICENSE` is missing or malformed;
- `TIMEOFF_LICENSE_PUBLIC_KEY` is missing;
- the license is not an RSA-SHA256 envelope, has an invalid signature, or is
  expired.

## Local Premium Development

For local development, mount the premium repository instead of copying it into
the image:

```sh
TIMEOFF_PREMIUM_MODULE_HOST_PATH=/path/to/timeoff-premium \
docker compose -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.premium-dev.yml up --build
```

The premium dev override:

- sets `NODE_ENV=development`;
- mounts the premium repo at `/opt/timeoff-premium`;
- sets `TIMEOFF_PREMIUM_MODULE=/opt/timeoff-premium`;
- enables `FEATURE_TIME_BALANCE=true`;
- enables `FEATURE_VACATION_PLANNING=true`.

Do not use `FEATURE_*` as the normal production path. Production should use a
signed license.

Production and staging ignore `TIMEOFF_FEATURES`, positive `FEATURE_*`
overrides, config feature allowlists, `ALLOW_UNSIGNED_LICENSES`,
`ALLOW_CONFIG_LICENSED_FEATURES`, and
`ALLOW_UNLICENSED_FEATURE_OVERRIDES`. Explicit `FEATURE_*=false` remains a
kill switch.

## Runtime contract

| Premium module | License | Result |
|---|---|---|
| absent, not required | absent | Community starts |
| absent, required | any | startup error |
| present in development | absent | dev flags may enable registered features |
| present and required in production | absent | startup error |
| present and required in production | invalid | startup error |
| present and required in production | valid RSA | only licensed features are enabled |

## RSA License

Generate keys outside customer deployments:

```sh
openssl genrsa -out license_private.pem 3072
openssl rsa -in license_private.pem -pubout -out license_public.pem
```

Generate a base64 license:

```sh
node bin/sign_license.js \
  --customer "Example Ltd" \
  --features sso_authentication,integration_api,employee_groups,work_calendars,leave_start_reminders,time_balance,vacation_planning \
  --expires 2027-12-31T23:59:59.000Z \
  --private-key-file license_private.pem \
  --base64
```

Set the output as `TIMEOFF_LICENSE`. Set the public key as
`TIMEOFF_LICENSE_PUBLIC_KEY`. If the public key is stored in an environment
variable, escape newlines as `\n`.

## Verification

Core checks:

```sh
./node_modules/.bin/mocha \
  t/unit/edition_premium_loader.js \
  t/unit/edition_community_boundary.js \
  t/unit/edition_registry.js \
  t/unit/features.js \
  t/unit/email_template_paths.js \
  t/unit/partial_template_paths.js
```

Premium checks:

```sh
cd /path/to/timeoff-premium
npm run check
npm test
```

External module smoke test:

```sh
TIMEOFF_PREMIUM_MODULE=/path/to/timeoff-premium \
FEATURE_TIME_BALANCE=true \
FEATURE_VACATION_PLANNING=true \
node -e "const app=require('./app'); const db=app.get('db_model'); const edition=require('./lib/edition'); const i18next=require('./lib/i18n').i18next; console.log(Boolean(db.TimeBalanceEntry)+','+Boolean(db.VacationPlan)+','+edition.getInfo().routes.length+','+i18next.t('nav.timeBalance')); process.exit(0);"
```

Expected output:

```text
true,true,2,Time balance
```
