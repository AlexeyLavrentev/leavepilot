# OEM deployment runbook

This runbook walks an operator through assembling a white-label (OEM) shipment
of the application from documentation only. It covers the three assembly steps
— brand configuration, license installation, and leak verification — using a
configuration overlay, environment variables, and a mounted license.

The shipment unit is a published container image plus a configuration overlay
(decision **D-10**): you mount your configuration, your license, and your
`BRAND_*` environment into the same image every customer runs. The brand is
**not** baked into the image — a rebrand is a configuration change followed by a
container restart, never a source modification or an image rebuild.

> OEM assembly is configuration-only. You do not work with application source to
> rebrand; you work with `config/app.json`, environment variables, the license,
> and the container image.

## What this runbook does not cover

Image publishing, container-registry tag conventions, and the release checklist
are release mechanics, covered separately in Phase 6. This runbook covers
assembly only: configure the brand, install the license, verify the leak guard.

## Prerequisites

Before you begin, have ready:

- a published application image (the image every customer runs);
- a signed OEM license whose payload carries the `custom_branding` entitlement
  (see [License installation](#2-license-installation));
- the license public key that matches the signing key;
- your custom brand assets (logo, favicons, app icon, manifest) hosted at URLs
  the deployment can reach, plus the product name, domains, and sender address
  you want users to see.

## 1. Brand configuration

A custom brand is **operator-config-gated** (decision **D-04**): the license
grants only the *right* to apply a custom brand; the brand data itself lives in
your configuration. Without a valid, non-grace `custom_branding` entitlement the
application shows the community default brand **regardless of your
configuration**.

You supply the brand through two equivalent paths — the `branding` section of
`config/app.json`, or the `BRAND_*` environment variables — both resolved by the
same layer. Environment variables take precedence over the config file, which
takes precedence over the built-in default. Either path is sufficient on its
own.

### Brand fields

The full configurable surface is the 14-field `branding.get()` contract (every
field you can rebrand is listed here):

| Field | `config/app.json` branding key | Environment variable |
|-------|--------------------------------|----------------------|
| Product name | `name` | `BRAND_NAME` |
| Short name | `shortName` | `BRAND_SHORT_NAME` |
| Application domain | `applicationDomain` | `APPLICATION_DOMAIN` |
| Promotion website domain | `promotionWebsiteDomain` | `PROMOTION_WEBSITE_DOMAIN` |
| Logo URL | `logoUrl` | `BRAND_LOGO_URL` |
| Favicon URL | `faviconUrl` | `BRAND_FAVICON_URL` |
| 32px PNG favicon | `faviconPng32Url` | `BRAND_FAVICON_PNG_32_URL` |
| 16px PNG favicon | `faviconPng16Url` | `BRAND_FAVICON_PNG_16_URL` |
| App icon URL | `appIconUrl` | `BRAND_APP_ICON_URL` |
| Apple touch icon URL | `appleTouchIconUrl` | `BRAND_APPLE_TOUCH_ICON_URL` |
| Web manifest URL | `manifestUrl` | `BRAND_MANIFEST_URL` |
| Sender email | `senderEmail` | `BRAND_SENDER_EMAIL` (or `APPLICATION_SENDER_EMAIL`) |
| Sender name | `senderName` | `BRAND_SENDER_NAME` |
| Email From header | `emailFrom` | `BRAND_EMAIL_FROM` (derived from sender name + email when unset) |

The `emailFrom` header is derived from the sender name and sender email when not
set explicitly. The complete contract — including the `oemActive` control flag
the license gate emits — is documented in
[features-branding.md](features-branding.md).

### Example: configuration overlay

Mount a `config/app.json` that carries a `branding` section:

```json
{
  "branding": {
    "name": "Acme Leave",
    "shortName": "Acme",
    "applicationDomain": "https://leave.acme.example",
    "promotionWebsiteDomain": "https://acme.example",
    "senderEmail": "no-reply@acme.example",
    "senderName": "Acme Leave",
    "logoUrl": "https://leave.acme.example/assets/acme-logo.svg",
    "faviconUrl": "/favicons/acme.ico",
    "faviconPng32Url": "/favicons/acme-32x32.png",
    "faviconPng16Url": "/favicons/acme-16x16.png",
    "appIconUrl": "/favicons/acme-icon.png",
    "appleTouchIconUrl": "/favicons/acme-touch-icon.png",
    "manifestUrl": "/acme.webmanifest"
  }
}
```

### Example: environment overlay

The same fields via environment — useful for a single-field change or a
secret-managed deployment:

```env
BRAND_NAME=Acme Leave
BRAND_SHORT_NAME=Acme
APPLICATION_DOMAIN=https://leave.acme.example
PROMOTION_WEBSITE_DOMAIN=https://acme.example
BRAND_SENDER_EMAIL=no-reply@acme.example
BRAND_SENDER_NAME=Acme Leave
BRAND_LOGO_URL=https://leave.acme.example/assets/acme-logo.svg
```

Because the brand is not baked into the image (**D-10**), changing a logo, a
name, or a domain is a configuration change plus a container restart — no image
rebuild.

## 2. License installation

The OEM entitlement is a signed **RSA-SHA256** license whose
`payload.features` array includes `custom_branding`. The license grants the right
to ship a custom brand; it does not itself carry the brand data (**D-04**).

Install the license and its public verification key through environment
variables:

```env
LEAVEPILOT_LICENSE=<base64 RSA-SHA256 license envelope, or inline JSON envelope>
LEAVEPILOT_LICENSE_PUBLIC_KEY=<PEM public key, newlines escaped as \n>
```

When the license lives in a file on disk, export its contents:

```bash
export LEAVEPILOT_LICENSE="$(cat /secrets/oem.license)"
export LEAVEPILOT_LICENSE_PUBLIC_KEY="$(cat /secrets/license_public_key.pem)"
```

Key generation, signing, envelope format, and verification are documented in
[license-operations.md](license-operations.md) and the License Payload section
of [features-branding.md](features-branding.md). This runbook does not duplicate
the crypto workflow — point your signing authority at those documents to issue
an OEM license with `custom_branding` in `features`.

### How the entitlement is enforced

The entitlement is verified by a single license-aware gate that reads the signed
payload directly. A **valid, non-grace** license carrying `custom_branding`
activates the custom brand; any other state falls back to the community default
brand immediately.

There is **no grace window for the custom brand** (decision **D-03**): an
expired, damaged, or missing OEM license reverts to the default brand at once —
not after the premium-style 14-day window. The fallback is silent to end users
(they see the default brand) but visible to the administrator.

### Observing license state

An administrator sees the current license state (valid, expiring, expired, or
damaged) on the `/settings/general/` page, which surfaces the license-status
line. A fallback to the default brand shows up here as an expired or error
state. This is the same license-status surface used in every deployment — no
separate OEM indicator is required.

## 3. Leak verification

Under an active `custom_branding` entitlement the rendered output must carry no
vendor trace — the vendor product name, short name, and promotion domain must
not appear on any user-visible surface. This is guaranteed by construction and
proven by a CI-gated regression test.

### What is verified

The canonical leak-surface manifest lives at
[`t/fixtures/oem-leak-surfaces.json`](../t/fixtures/oem-leak-surfaces.json), with
a human-readable description in
[oem-leak-surfaces.md](oem-leak-surfaces.md). It enumerates every rendered
surface that carries brand data: the page `<title>` and favicons, the navbar,
the footer copyright, the web manifest, the login page, the iCal feed
identifiers, the email `From:` address, and the license-status section.

The CI-gated test [`t/unit/oem_no_vendor_leak.js`](../t/unit/oem_no_vendor_leak.js)
renders every dynamic surface under a sentinel custom brand and asserts both
that the custom brand is **present** and that no vendor literal (`LeavePilot`,
`Leave Pilot`, `TimeOff`, `timeoff.management`) is **absent**. It runs on every
change through `npm run test:coverage`, the same pipeline that gates every pull
request.

### Confirm your custom brand surfaces

After booting the image with your brand overlay and an active OEM license,
confirm:

1. the login page shows your product name;
2. the browser tab title (`<title>`) and the web manifest carry your brand name;
3. the navbar and footer show your brand name and copyright;
4. the application domain in emails and calendar feeds matches your configured
   domain.

### Confirm no vendor trace

Under an active OEM entitlement the vendor name is absent by construction: the
gate suppresses the vendor/upsell section entirely, and every brand-bearing
surface reads your configured brand. The regression test above is the ongoing
proof — you do not need to grep the output yourself; run the test suite:

```bash
npm run test:coverage
```

A green `oem_no_vendor_leak` result is the proof that no vendor literal reaches a
rendered surface under a custom brand.

> One intentional, documented out-of-scope item: the JavaScript runtime
> namespace identifier (the `window.timeoff` key and related config/theme keys)
> is a devtools-observable code identifier, not rendered user-facing text
> (decision **D-11**). It is excluded from the leak manifest and is not a brand
> surface.

## Troubleshooting

### My configured brand does not appear — I see the default brand

The license gate did not see a valid, non-grace `custom_branding` entitlement.
Check, in order:

1. `LEAVEPILOT_LICENSE` is set and is the OEM license — its `features` include
   `custom_branding`.
2. `LEAVEPILOT_LICENSE_PUBLIC_KEY` matches the key that signed the license.
3. the license has not expired — no grace applies to OEM (**D-03**).
4. the license signature is intact (the envelope was not truncated or mangled).

An administrator can confirm the live state on `/settings/general/`.

### The vendor upsell reappears

This only happens when the OEM entitlement is inactive (see above). Under an
active entitlement the vendor/upsell section is suppressed entirely.

### A custom field is ignored

Confirm the field is one of the 14 contracted fields above and is spelled
exactly (mind the camelCase). Environment variables take precedence over the
config file. A field overridden in your overlay takes effect only while the OEM
entitlement is active; without it, your configuration is ignored and the default
brand is shown.

## Related documents

- [features-branding.md](features-branding.md) — the `branding.get()` contract
  and the `oemActive` control flag.
- [license-operations.md](license-operations.md) — license format, key
  generation, signing, and verification.
- [oem-leak-surfaces.md](oem-leak-surfaces.md) — the leak-surface manifest and
  the regression-test principle.
