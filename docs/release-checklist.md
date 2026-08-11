# Release Checklist

Use this checklist before publishing a LeavePilot Community or Premium build.

## 1. Confirm Repository State

Core repository:

```sh
cd /path/to/timeoff
git status --short
git log --oneline -5
```

Premium repository:

```sh
cd /path/to/timeoff-premium
git status --short
git log --oneline -5
```

Expected:

- no uncommitted release changes;
- no `.env`, key, license, database dump, or customer data staged;
- core and premium CI are green on GitHub.

## 2. Run Local Checks

Core:

```sh
cd /path/to/timeoff

./node_modules/.bin/mocha \
  t/unit/edition_premium_loader.js \
  t/unit/edition_community_boundary.js \
  t/unit/edition_registry.js \
  t/unit/features.js \
  t/unit/email_template_paths.js \
  t/unit/partial_template_paths.js
```

Premium:

```sh
cd /path/to/timeoff-premium
npm run check
npm test
```

Production dependency audit:

```sh
npm audit --omit=dev
```

Release gate: zero `high` and zero `critical` findings. The 2.1.0 audit reports
the known moderate `uuid <11.1.1` advisory through Sequelize 6.37.x. Its affected
buffer-writing paths are UUID v3/v5/v6; this Sequelize line imports UUID v1/v4
only. npm's suggested “fix” downgrades Sequelize to 3.30.0 and must not be
applied. Reassess when Sequelize provides a compatible dependency update.

Compose configuration:

```sh
cd /path/to/timeoff

SESSION_SECRET=ci-session-secret \
CRYPTO_SECRET=ci-crypto-secret \
docker compose config --quiet

SESSION_SECRET=ci-session-secret \
CRYPTO_SECRET=ci-crypto-secret \
TIMEOFF_PREMIUM_MODULE_HOST_PATH=/path/to/timeoff-premium \
TIMEOFF_LICENSE=ci-license-placeholder \
TIMEOFF_LICENSE_PUBLIC_KEY=ci-public-key-placeholder \
docker compose -f docker-compose.yml -f docker-compose.commercial.yml config --quiet
```

## 3. Community Build

Community build contains only the source-available core.

```sh
cd /path/to/timeoff
docker compose build app
```

Community runtime expectations:

- `TIMEOFF_PREMIUM_MODULE` is empty;
- premium DB models are absent;
- premium routes are absent;
- premium migrations are not applied.

Quick community boundary check:

```sh
./node_modules/.bin/mocha t/unit/edition_community_boundary.js
```

## 4. Commercial Build

Commercial build copies the private premium module into the Docker image.

Required inputs:

- private premium repo path;
- signed RSA license;
- public license key;
- production secrets.

Build and start:

```sh
TIMEOFF_PREMIUM_MODULE_HOST_PATH=/path/to/timeoff-premium \
TIMEOFF_LICENSE=PASTE_BASE64_LICENSE_HERE \
TIMEOFF_LICENSE_PUBLIC_KEY=PASTE_PUBLIC_KEY_WITH_ESCAPED_NEWLINES_HERE \
docker compose -f docker-compose.yml -f docker-compose.commercial.yml up --build -d
```

Commercial runtime expectations:

- premium module is copied to `/opt/timeoff-premium`;
- `TIMEOFF_PREMIUM_MODULE=/opt/timeoff-premium`;
- `TIMEOFF_PREMIUM_MODULE_REQUIRED=true`;
- signed license is valid;
- premium migrations run during `npm run db-update`.

## 5. License Issue Flow

Generate an RSA key pair outside customer deployments:

```sh
openssl genrsa -out license_private.pem 3072
openssl rsa -in license_private.pem -pubout -out license_public.pem
```

Generate a customer license:

```sh
node bin/sign_license.js \
  --customer "Customer Name" \
  --features sso_authentication,integration_api,employee_groups,work_calendars,leave_start_reminders,time_balance,vacation_planning \
  --expires 2027-12-31T23:59:59.000Z \
  --private-key-file license_private.pem \
  --base64
```

Never commit:

- `license_private.pem`;
- generated customer licenses;
- customer-specific `.env` files.

Customer deployment receives:

- `TIMEOFF_LICENSE`;
- `TIMEOFF_LICENSE_PUBLIC_KEY`;
- commercial image or premium package access.

## 6. Migration Check

Before serving traffic, run:

```sh
npm run db-update
```

For Docker Compose deployments this can be automatic through
`RUN_DB_MIGRATIONS=true`, but controlled production releases should prefer a
separate migration step.

Expected commercial migration output includes premium migrations:

```text
20260521123000-create-time-balance-entries.js
20260602120000-add-vacation-plans-and-time-balance-details.js
20260602130000-link-vacation-plans-to-leaves.js
```

## 7. Smoke Tests

External module smoke:

```sh
TIMEOFF_PREMIUM_MODULE=/path/to/timeoff-premium \
FEATURE_TIME_BALANCE=true \
FEATURE_VACATION_PLANNING=true \
node -e "const app=require('./app'); const db=app.get('db_model'); const edition=require('./lib/edition'); const i18next=require('./lib/i18n').i18next; console.log(Boolean(db.TimeBalanceEntry)+','+Boolean(db.VacationPlan)+','+edition.getInfo().routes.length+','+i18next.t('nav.timeBalance')); process.exit(0);"
```

Expected:

```text
true,true,2,Time balance
```

Docker HTTP smoke:

```sh
curl -I http://127.0.0.1:${APP_PORT:-3000}/
```

Expected:

- HTTP `302` to `./login/`, or another non-error application response;
- app logs do not contain startup errors;
- `db`, `redis`, and `app` containers are healthy.

## 8. Version Compatibility

Premium compatibility metadata is stored in:

```text
/path/to/timeoff-premium/package.json
```

The `timeoffCore` field records:

- premium module contract version;
- exact 40-character core commit used by premium CI (`testedWithRef`);
- expected public core version and tag separately;
- required core extension points.

Before a commercial release:

1. Confirm premium CI uses the exact immutable core SHA.
2. After merging core, compare the merge result with `testedWithRef`; if the
   SHA changed, update the pin and rerun the full Premium suite.
3. Never replace `testedWithRef` with a branch or tag; keep `targetTag` for the
   human-facing release name.
4. Tag core and premium together only after both final SHAs are verified.

Release tags:

```sh
CORE_VERSION=2.1.0
PREMIUM_VERSION=0.3.0

git -C /path/to/timeoff tag "v${CORE_VERSION}"
git -C /path/to/timeoff push origin "v${CORE_VERSION}"

git -C /path/to/timeoff-premium tag "v${PREMIUM_VERSION}"
git -C /path/to/timeoff-premium push origin "v${PREMIUM_VERSION}"
```

Pushing a semantic version tag starts the corresponding container publication
workflow. To republish an existing tag, use **Run workflow** in GitHub Actions
and provide the existing tag.

## 9. Verify Published Images

Community:

```sh
CORE_VERSION=2.1.0
docker buildx imagetools inspect \
  "ghcr.io/alexeylavrentev/leavepilot-community:${CORE_VERSION}"
```

Expected:

- the manifest contains `linux/amd64` and `linux/arm64`;
- the package is publicly readable;
- the Community smoke test passed in GitHub Actions.

Premium:

```sh
PREMIUM_VERSION=0.3.0
CORE_VERSION=2.1.0
PREMIUM_IMAGE="ghcr.io/alexeylavrentev/leavepilot-premium:${PREMIUM_VERSION}-core-${CORE_VERSION}"

echo "$GHCR_TOKEN" |
  docker login ghcr.io -u "$GITHUB_LOGIN" --password-stdin
docker buildx imagetools inspect "$PREMIUM_IMAGE"
```

Expected:

- the manifest contains `linux/amd64` and `linux/arm64`;
- the Premium content smoke test passed in GitHub Actions;
- an unauthenticated registry request returns `401`;
- no license, signing key, or customer secret is embedded in the image.

## 10. Rollback

Rollback options:

- redeploy the previous core image;
- redeploy the previous commercial image;
- disable a specific premium feature with explicit `FEATURE_NAME=false`;
- restore a database backup if a migration must be rolled back.

Do not rely on destructive manual DB edits as the first rollback path.

For commercial deployments, keep:

- previous image tag;
- previous premium module commit/tag;
- database backup before migrations;
- previous customer license if license scope changed.

## 11. Final Release Gate

Release only when all are true:

- core CI is green;
- premium CI is green;
- local focused checks pass;
- commercial Docker smoke passes;
- RSA license has been generated for the intended customer;
- no secrets are committed;
- release notes mention whether migrations are included;
- Community and Premium manifests contain both supported architectures;
- Community is public and Premium remains private;
- rollback image/tag and DB backup exist.
