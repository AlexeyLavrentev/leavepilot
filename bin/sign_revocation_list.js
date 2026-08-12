#!/usr/bin/env node

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const minimist = require('minimist');
const envResolver = require('../lib/env_resolver');
const features = require('../lib/features');

const argv = minimist(process.argv.slice(2));
const privateKey = argv['private-key']
  || (argv['private-key-file'] ? fs.readFileSync(argv['private-key-file'], 'utf8') : '')
  || envResolver.resolve('LICENSE_REVOCATION_PRIVATE_KEY');
const revokedLicenseIds = String(argv.revoked || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);

if (!privateKey || !argv.expires) {
  process.stderr.write(
    'Usage: node bin/sign_revocation_list.js --revoked id1,id2 '
    + '--expires 2027-01-01T00:00:00.000Z --private-key-file key.pem [--base64]\n'
  );
  process.exit(1);
}

if (Number.isNaN(Date.parse(argv.expires)) || Date.parse(argv.expires) <= Date.now()) {
  process.stderr.write('Error: --expires must be a future ISO date.\n');
  process.exit(1);
}

const payload = {
  schemaVersion: 1,
  listId: String(argv['list-id'] || crypto.randomUUID()),
  issuedAt: new Date().toISOString(),
  expiresAt: new Date(argv.expires).toISOString(),
  revokedLicenseIds: [...new Set(revokedLicenseIds)].sort(),
};
const envelope = {
  payload,
  algorithm: 'RSA-SHA256',
  signature: features.signLicensePayloadWithPrivateKey(payload, privateKey),
};
const output = JSON.stringify(envelope);

process.stdout.write(argv.base64
  ? Buffer.from(output, 'utf8').toString('base64') + '\n'
  : JSON.stringify(envelope, null, 2) + '\n');
