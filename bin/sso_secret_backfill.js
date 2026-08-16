#!/usr/bin/env node
'use strict';

const minimist = require('minimist');
const envResolver = require('../lib/env_resolver');

const args = minimist(process.argv.slice(2), {
  boolean: ['apply', 'dry-run', 'help'],
  alias: { h: 'help' },
});

function usage() {
  process.stdout.write([
    'Usage: node bin/sso_secret_backfill.js [--dry-run|--apply]',
    '',
    '  --dry-run  report category counts without changing rows (default)',
    '  --apply    encrypt every valid plaintext SSO client secret',
    '',
  ].join('\n'));
}

if (args.help) {
  usage();
  process.exit(0);
}

if (args.apply && args['dry-run']) {
  process.stderr.write('Choose either --dry-run or --apply\n');
  process.exit(2);
}

const mode = args.apply ? 'apply' : 'dry-run';
const productionLike = ['production', 'staging'].indexOf(process.env.NODE_ENV) !== -1;

if (args.apply && productionLike && !envResolver.resolve('SECRET_KEY') && !process.env.CRYPTO_SECRET) {
  process.stderr.write('SSO secret backfill refused: encryption key is not configured\n');
  process.exit(1);
}

const db = require('../lib/model/db');
const backfill = require('../lib/sso_secret_backfill');
const operation = args.apply ? backfill.apply : backfill.audit;

db.connect()
  .then(function() {
    return operation({ sequelize: db.sequelize });
  })
  .then(function(summary) {
    process.stdout.write(backfill.formatSummary(mode, summary) + '\n');
  })
  .catch(function(error) {
    if (error && error.summary) {
      process.stderr.write(backfill.formatSummary(mode + ' failed', error.summary) + '\n');
    }
    process.stderr.write((error && error.message || 'SSO secret backfill failed') + '\n');
    process.exitCode = 1;
  })
  .finally(function() {
    return db.sequelize.close();
  });
