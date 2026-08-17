#!/usr/bin/env node
'use strict';

/*
  License contract fixture generator (Phase 8, D-15/D-16/D-18).

  Regenerates the committed fixture package deterministically: the same input
  constants always produce byte-identical output (RSA-SHA256 with PKCS#1 v1.5
  is deterministic; every date and id below is a hard constant).

  Regeneration procedure (D-20; the same steps live in LICENSE-CONTRACT.md
  "Change Procedure"):
    1. change the package in the COMMUNITY repository (never the portal copy);
    2. run this script — it rewrites every fixture and MANIFEST.json;
    3. copy the package byte-for-byte into the portal repository;
    4. both sides' CI must be green before either merge is done.

  This script is byte-identical in both repositories and requires NOTHING
  beyond node builtins (fs, path, crypto): repo module paths differ between
  the two repositories and must never be required here. The community major
  version stamped into allowedMajorVersions is a hard constant for the same
  reason — never read from package.json.

  All fixture dates are hard constants anchored to FROZEN (D-16): the spec
  freezes the verifier clock to FROZEN, so the committed fixtures never rot.
*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PKG_DIR = __dirname;
const REPO_ROOT = path.join(PKG_DIR, '..');

// The single frozen "now" of the whole package (D-16). The spec runs the real
// verifier with Date frozen here; every window in the fixtures is computed
// around this constant by hand, never from the runtime clock.
const FROZEN_ISO = '2026-06-01T00:00:00.000Z';
const FROZEN = Date.parse(FROZEN_ISO);

// The community major the fixtures claim (see header comment; hard constant).
const COMMUNITY_MAJOR = 3;

// D-13: the keyId marks every fixture as test-only. Nobody trusts these keys.
const KEY_ID = 'test-license-do-not-trust';

const LICENSE_PRIVATE_KEY_FILE = path.join(PKG_DIR, 'keys', 'test-license.private.testkey');
const REVOCATION_PRIVATE_KEY_FILE = path.join(PKG_DIR, 'keys', 'test-revocation.private.testkey');

/*
  Canonicalization + signing — the byte rule of the contract, inlined as the
  third byte-equivalent copy (lib/features.js, portal license_service.js, and
  this script). Do not "improve" it: any divergence breaks every signature.
*/
const canonicalize = value => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = canonicalize(value[key]);
      return acc;
    }, {});
  }
  return value;
};

const canonicalJson = value => JSON.stringify(canonicalize(value));

const signPayload = (payload, privatePem) =>
  crypto.sign('RSA-SHA256', Buffer.from(canonicalJson(payload)), privatePem).toString('base64');

// ---------------------------------------------------------------------------
// Fixed inputs (D-15/D-16: hard constants only — no runtime clock, no random).
// ---------------------------------------------------------------------------

const CUSTOMER_NAME = 'LeavePilot Contract Fixture Customer';
const FEATURES = [
  'ldap_authentication',
  'sso_authentication',
  'integration_api',
  'employee_groups',
  'work_calendars',
  'custom_branding',
];

const LICENSE_ID_VALID = '00000000-0000-4000-8000-000000000001';
const LICENSE_ID_REVOKED = '00000000-0000-4000-8000-000000000002';
const LICENSE_ID_MISS = '00000000-0000-4000-8000-000000000003';
const CUSTOMER_ID = '00000000-0000-4000-8000-0000000000a1';

const EXPIRES_FAR_FUTURE = '2099-06-01T00:00:00.000Z';
const EXPIRES_LONG_PAST = '2020-01-01T00:00:00.000Z';
const EXPIRES_GRACE = '2026-05-25T00:00:00.000Z'; // FROZEN minus 7 days (inside the 14-day window)

const REVOCATION_LIST_ID = '00000000-0000-4000-8000-0000000000b1';

// Payload construction in the portal issuer's field order
// (services/license_service.js): fixed core first, optional commercial
// fields after.
const buildPayload = overrides => Object.assign({
  schemaVersion: 2,
  licenseId: LICENSE_ID_VALID,
  customerId: CUSTOMER_ID,
  customerName: CUSTOMER_NAME,
  customer: CUSTOMER_NAME,
  features: FEATURES.slice(),
  issuedAt: FROZEN_ISO,
  allowedMajorVersions: [COMMUNITY_MAJOR],
  plan: 'pro',
  expiresAt: EXPIRES_FAR_FUTURE,
  maxActiveUsers: 25,
  keyId: KEY_ID,
}, overrides || {});

const buildEnvelope = (payload, privatePem) => ({
  payload,
  algorithm: 'RSA-SHA256',
  signature: signPayload(payload, privatePem),
});

const writeJson = (relPath, value) => {
  fs.writeFileSync(path.join(PKG_DIR, relPath), JSON.stringify(value, null, 2) + '\n');
};

// ---------------------------------------------------------------------------
// Fixture definitions. Each entry states why it exists (the meta block is the
// oem-leak manifest discipline: no entry without an honest reason).
// ---------------------------------------------------------------------------

const fixtures = {

  'valid.json': {
    envelope: licenseKey => buildEnvelope(buildPayload(), licenseKey),
    meta: {
      outcome: 'valid',
      expectedReason: 'valid',
      env: [],
      why: 'Baseline positive: a correctly signed schemaVersion-2 payload with keyId resolves through the key ring and verifies valid at the frozen now (2026-06-01, before the 2099 expiry).',
    },
  },
};

// Deliberately a fixed list, not a directory walk: regeneration must fail
// loudly when a required fixture disappears, and a dynamic list would simply
// shrink with it (scripts/verify-artifact-licenses.sh discipline).
const OUTPUT_FILES = ['valid.json'];

// ---------------------------------------------------------------------------
// Run.
// ---------------------------------------------------------------------------

const licensePrivateKey = fs.readFileSync(LICENSE_PRIVATE_KEY_FILE, 'utf8');
let revocationPrivateKey = null;
if (fs.existsSync(REVOCATION_PRIVATE_KEY_FILE)) {
  revocationPrivateKey = fs.readFileSync(REVOCATION_PRIVATE_KEY_FILE, 'utf8');
}

OUTPUT_FILES.forEach(relPath => {
  const definition = fixtures[relPath];
  if (!definition) {
    throw new Error('OUTPUT_FILES names ' + relPath + ' but no fixture definition exists for it');
  }
  writeJson(relPath, {
    envelope: definition.envelope(licensePrivateKey, revocationPrivateKey),
    meta: definition.meta,
  });
});

process.stdout.write('license-contract-fixtures: wrote ' + OUTPUT_FILES.join(', ') + ' (frozen now: ' + FROZEN_ISO + ')\n');
