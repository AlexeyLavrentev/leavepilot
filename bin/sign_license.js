#!/usr/bin/env node

'use strict';

const argv = require('minimist')(process.argv.slice(2));
const fs = require('fs');
const envResolver = require('../lib/env_resolver');
const features = require('../lib/features');

const parseList = value => String(value || '')
  .split(',')
  .map(item => item.trim())
  .filter(Boolean);

const AVAILABLE_FEATURES = [
  ...Object.keys(features.catalog),
  ...Object.keys(features.planPresets).reduce((acc, name) => {
    features.planPresets[name].features.forEach(f => {
      if (acc.indexOf(f) === -1) acc.push(f);
    });
    return acc;
  }, []),
].filter((v, i, a) => a.indexOf(v) === i);

const printUsageAndExit = () => {
  const planLines = Object.keys(features.planPresets).map(name => {
    const preset = features.planPresets[name];
    return `    ${name.padEnd(12)} ${preset.description} [${preset.features.length ? preset.features.join(', ') : 'defaults only'}]`;
  });

  process.stderr.write([
    'Usage:',
    '  node bin/sign_license.js --customer "Name" --plan <starter|pro|enterprise> --private-key-file key.pem [--expires 2027-12-31] [--base64]',
    '  node bin/sign_license.js --customer "Name" --features feat1,feat2 --private-key-file key.pem [--expires 2027-12-31] [--base64]',
    '',
    'Options:',
    '  --customer        Customer name (required)',
    '  --plan            Plan preset (alternative to --features):',
    ...planLines,
    '  --features        Comma-separated feature list (alternative to --plan)',
    '  --expires         Expiry date in ISO format (optional; stored as expiresAt in v2)',
    '  --private-key-file  Path to RSA private key PEM file',
    '  --private-key     Private key PEM string (prefer --private-key-file)',
    '  --secret          HMAC secret (legacy, prefer RSA)',
    '  --base64          Output as base64 instead of JSON',
    '',
    'Schema v2 options (v2 is the default; pass --schema 1 for legacy payloads):',
    '  --license-id      Unique license id (default: generated UUID)',
    '  --customer-id     Stable customer identifier (CRM/portal id)',
    '  --not-before      License is not valid before this ISO date',
    '  --maintenance-until  End of updates/support entitlement (ISO date)',
    '  --max-active-users   Licensed active user count (soft limit, informational)',
    '  --allowed-major-versions  Comma-separated core major versions, e.g. "2,3"',
    '  --key-id          Signing key identifier for key-ring rotation',
    '',
    'Available features:',
    `  ${AVAILABLE_FEATURES.join(', ')}`,
    '',
  ].join('\n'));
  process.exit(1);
};

const secret = argv.secret || envResolver.resolve('LICENSE_SECRET');
const privateKey = argv['private-key']
  || (argv['private-key-file'] ? fs.readFileSync(argv['private-key-file'], 'utf8') : '')
  || envResolver.resolve('LICENSE_PRIVATE_KEY');

let licenseFeatures;
let resolvedPlan = null;

if (argv.features) {
  licenseFeatures = parseList(argv.features);
} else if (argv.plan) {
  const preset = features.resolvePlan(argv.plan);

  if (!preset) {
    process.stderr.write(`Unknown plan: ${argv.plan}. Available: ${Object.keys(features.planPresets).join(', ')}\n`);
    process.exit(1);
  }

  licenseFeatures = preset.features;
  resolvedPlan = argv.plan;
}

if (!argv.customer || (!licenseFeatures && !resolvedPlan) || (!secret && !privateKey)) {
  printUsageAndExit();
}

const schemaVersion = Number(argv.schema || 2);

if (![1, 2].includes(schemaVersion)) {
  process.stderr.write('Error: --schema must be 1 or 2.\n');
  process.exit(1);
}

const requireValidDate = (name, value) => {
  if (value && Number.isNaN(Date.parse(value))) {
    process.stderr.write(`Error: --${name} must be a valid ISO date.\n`);
    process.exit(1);
  }
};

requireValidDate('expires', argv.expires);
requireValidDate('not-before', argv['not-before']);
requireValidDate('maintenance-until', argv['maintenance-until']);

const maxActiveUsers = argv['max-active-users'] === undefined
  ? null
  : Number(argv['max-active-users']);

if (maxActiveUsers !== null
    && (!Number.isSafeInteger(maxActiveUsers) || maxActiveUsers < 1)) {
  process.stderr.write('Error: --max-active-users must be a positive integer.\n');
  process.exit(1);
}

const allowedMajorVersions = argv['allowed-major-versions']
  ? parseList(argv['allowed-major-versions']).map(Number)
  : null;

if (allowedMajorVersions
    && (!allowedMajorVersions.length
      || allowedMajorVersions.some(version => !Number.isSafeInteger(version) || version < 1))) {
  process.stderr.write('Error: --allowed-major-versions must contain positive integers.\n');
  process.exit(1);
}

const payload = {
  customer: argv.customer,
  features: licenseFeatures,
};

if (resolvedPlan) {
  payload.plan = resolvedPlan;
}

if (schemaVersion >= 2) {
  const { randomUUID } = require('crypto');

  payload.schemaVersion = schemaVersion;
  payload.licenseId = String(argv['license-id'] || randomUUID());
  payload.customerName = argv.customer;
  payload.issuedAt = new Date().toISOString();

  if (argv['customer-id']) {
    payload.customerId = String(argv['customer-id']);
  }
  if (argv['not-before']) {
    payload.notBefore = argv['not-before'];
  }
  if (argv.expires) {
    payload.expiresAt = argv.expires;
  }
  if (argv['maintenance-until']) {
    payload.maintenanceUntil = argv['maintenance-until'];
  }
  if (maxActiveUsers !== null) {
    payload.maxActiveUsers = maxActiveUsers;
  }
  if (allowedMajorVersions) {
    payload.allowedMajorVersions = allowedMajorVersions;
  }
  if (argv['key-id']) {
    payload.keyId = String(argv['key-id']);
  }
} else if (argv.expires) {
  payload.expires = argv.expires;
}

const envelope = privateKey
  ? {
      payload,
      algorithm: 'RSA-SHA256',
      signature: features.signLicensePayloadWithPrivateKey(payload, privateKey),
    }
  : {
      payload,
      algorithm: 'HMAC-SHA256',
      signature: features.signLicensePayload(payload, secret),
    };

if (argv.base64) {
  console.log(Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64'));
} else {
  console.log(JSON.stringify(envelope, null, 2));
}
