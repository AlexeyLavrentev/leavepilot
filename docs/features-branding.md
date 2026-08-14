# Features, Licensing, and Branding

This fork keeps the original leave-management surface available by default and exposes newer modules through feature flags.

## Protection boundary

This is a source-available, self-hosted codebase. Feature flags and signed licenses
raise the operational and contractual boundary for official builds, but they are
not unbreakable DRM. Anyone with full source access can patch checks in their
own fork. For stronger protection, keep premium implementation code in a private
module loaded through the edition registry described in `docs/premium-module.md`.

## Branding

Default branding lives in `config/app.json`:

```json
"branding": {
  "name": "LeavePilot",
  "shortName": "LeavePilot",
  "logoUrl": "",
  "faviconUrl": "/favicon.ico"
}
```

Deployment-specific branding can be supplied through environment variables:

- `BRAND_NAME`
- `BRAND_SHORT_NAME`
- `BRAND_LOGO_URL`
- `BRAND_FAVICON_URL`
- `APPLICATION_DOMAIN`
- `PROMOTION_WEBSITE_DOMAIN`

The app reads these values in `lib/branding.js` and exposes them to templates as `branding`. Email links and the visible product name use the same source.

> `TIMEOFF_*` environment names remain supported as deprecated aliases and are resolved to their `LEAVEPILOT_*` equivalent; a deprecation warning is emitted once at boot when any are set. New deployments should use the canonical `LEAVEPILOT_*` names.

## Name and spacing

The product name is spelled two ways on purpose. Human-readable titles, this
README, and prose use "Leave Pilot" (with a space). The brand token — the
package name, the `LEAVEPILOT_` environment-variable prefix, and the
`branding.get().name` value that templates and feeds render — is "LeavePilot"
(no space). One spelling is for people to read; the other is the
machine-stable identifier that configuration, environment, and UI labels key
off. A rebrand changes both through `branding.get()` and the `BRAND_NAME`
environment override, never by editing strings in templates or locale files.

## Contract

`branding.get()` (in `lib/branding.js`) returns a stable object. The fields it
returns today are the contract:

- `name`
- `shortName`
- `applicationDomain`
- `promotionWebsiteDomain`
- `logoUrl`
- `faviconUrl`
- `faviconPng32Url`
- `faviconPng16Url`
- `appIconUrl`
- `appleTouchIconUrl`
- `manifestUrl`
- `senderEmail`
- `senderName`
- `emailFrom` (derived from `senderName` and `senderEmail` when not set
  explicitly)
- `oemActive` (boolean control flag — the OEM suppression signal from the
  license-aware gate in `get()`; **not** a brand-display field. `true` only
  when a valid, non-grace license carries the `custom_branding` entitlement.
  Under `oemActive` the operator's configured brand surfaces; otherwise
  `get()` returns the default brand regardless of `BRAND_*`/config, and the
  Phase 3 upsell section stays visible.)

Backward compatibility: adding a field is a non-breaking change. Removing or
renaming a field is a breaking change that requires a major version bump.
Future consumers — the PDF renderer, premium modules, and custom templates —
may depend on the full return shape, so every field above is part of the
public surface.

`logoUrl` is a contracted field but is intentionally empty (`''`) until brand
artwork is supplied; the field is present and stable, the value is not.

## Feature Flags

Premium features are defined in `lib/features.js`.

Current feature names:

- `sso_authentication`
- `integration_api`
- `time_balance`
- `vacation_planning`
- `employee_groups`
- `work_calendars`
- `leave_start_reminders`

Enable all features for development or tests:

```sh
LEAVEPILOT_FEATURES=all npm test
```

Enable selected features:

```sh
LEAVEPILOT_FEATURES=sso_authentication,integration_api npm start
```

Enable or disable a single feature explicitly:

```sh
FEATURE_TIME_BALANCE=true npm start
FEATURE_VACATION_PLANNING=false npm start
```

`LEAVEPILOT_FEATURES`, `FEATURE_*`, and `features` in config are development/test
overrides. Production-like environments (`production` and `staging`) always
ignore positive unlicensed overrides.

Explicit `false` overrides always work as a kill switch, even for licensed features.

`config/app.json` also supports:

```json
"licensed_features": ["time_balance", "vacation_planning"],
"features": {
  "integration_api": true
}
```

`licensed_features` is a local allowlist for development and tests.
Production-like environments always ignore it.

## License Payload

`LEAVEPILOT_LICENSE` may contain JSON or base64-encoded JSON. In development and test environments, an unsigned payload is accepted:

```json
{
  "customer": "Example Ltd",
  "features": ["sso_authentication", "integration_api"]
}
```

In production-like environments (`production` and `staging`), unsigned
licenses are always rejected.

Recommended RSA signed license envelope:

```json
{
  "payload": {
    "customer": "Example Ltd",
    "features": ["sso_authentication", "integration_api"],
    "expires": "2027-12-31T23:59:59.000Z"
  },
  "algorithm": "RSA-SHA256",
  "signature": "base64-encoded-signature"
}
```

Generate a private/public key pair outside customer deployments:

```sh
openssl genrsa -out license_private.pem 3072
openssl rsa -in license_private.pem -pubout -out license_public.pem
```

Keep `license_private.pem` only on your signing machine. Put the public key into
commercial deployments with `LEAVEPILOT_LICENSE_PUBLIC_KEY` or `license_public_key`.
When storing a PEM key in an environment variable, encode line breaks as `\n`.

Generate an RSA signed license:

```sh
node bin/sign_license.js --customer "Example Ltd" --features sso_authentication,integration_api,employee_groups,work_calendars,leave_start_reminders,time_balance,vacation_planning --expires 2027-12-31T23:59:59.000Z --private-key-file license_private.pem
```

Add `--base64` when the deployment expects a compact value for `LEAVEPILOT_LICENSE`.

Legacy HMAC signed envelopes remain readable for development and compatibility
outside commercial startup validation:

```json
{
  "payload": {
    "customer": "Example Ltd",
    "features": ["sso_authentication", "integration_api", "employee_groups", "work_calendars", "leave_start_reminders", "time_balance", "vacation_planning"],
    "expires": "2027-12-31T23:59:59.000Z"
  },
  "algorithm": "HMAC-SHA256",
  "signature": "hex-encoded-hmac-sha256"
}
```

The signature is HMAC-SHA256 over canonical JSON of `payload`. The signing secret is read from `LEAVEPILOT_LICENSE_SECRET` or `license_secret`.

Generate a legacy HMAC signed license:

```sh
node bin/sign_license.js --customer "Example Ltd" --features sso_authentication,integration_api,employee_groups,work_calendars,leave_start_reminders,time_balance,vacation_planning --expires 2027-12-31T23:59:59.000Z --secret "$LEAVEPILOT_LICENSE_SECRET"
```

Prefer RSA for self-hosted commercial deployments, because the customer
environment only needs the public verification key. HMAC requires the same
secret to sign and verify licenses, so it is mostly useful for internal
deployments or compatibility with older licenses.

Expired licenses and licenses with malformed `expires` values do not enable
premium features. Runtime diagnostics should use `features.getLicenseStatus()`,
which intentionally omits the raw license, signature, and signing secret.

The rest of the app depends only on `features.isEnabled(name)`, so route and template checks do not need to know where a feature came from.

## Commercial Docker example

For a self-hosted commercial deployment, use a signed license and a private
premium module. The exact module name depends on your private package or image:

```env
NODE_ENV=production
SESSION_SECRET=replace-with-long-random-value
CRYPTO_SECRET=replace-with-another-long-random-value

LEAVEPILOT_LICENSE=PASTE_BASE64_LICENSE_HERE
LEAVEPILOT_LICENSE_PUBLIC_KEY=PASTE_PUBLIC_KEY_WITH_ESCAPED_NEWLINES_HERE

LEAVEPILOT_PREMIUM_MODULE=@your-company/timeoff-premium
LEAVEPILOT_PREMIUM_MODULE_REQUIRED=true
```

For local development with the private premium repository:

```env
LEAVEPILOT_PREMIUM_MODULE=/path/to/timeoff-premium
```

For commercial delivery, prefer the private package name or the path where the
private package is installed in the image.

Commercial startup with `LEAVEPILOT_PREMIUM_MODULE_REQUIRED=true` accepts only a
valid RSA-SHA256 license. Development-only overrides such as
`LEAVEPILOT_FEATURES=all` are ignored in production and staging.
