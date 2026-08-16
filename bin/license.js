#!/usr/bin/env node

'use strict';

const argv = require('minimist')(process.argv.slice(2));
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const envResolver = require('../lib/env_resolver');
const features = require('../lib/features');

const subcommand = argv._[0];

const printUsageAndExit = () => {
  process.stderr.write([
    'LeavePilot License CLI',
    '',
    'Usage:',
    '  node bin/license.js inspect <license-file-or-string>         Show license payload (no private key needed)',
    '  node bin/license.js verify  <license-file-or-string> [--public-key-file key.pem]  Verify signature',
    '  node bin/license.js generate --customer "Name" --plan <plan> --private-key-file key.pem [--out file] [--registry file] [--expires date]',
    '  node bin/license.js registry --registry <file>               List issued licenses from registry',
    '  node bin/license.js plans                                    List available plan presets',
    '',
    'Generate options:',
    '  --out <file>        Write license to file instead of stdout',
    '  --registry <file>   Append metadata to a vendor-side registry JSON file',
    '',
    'Global options:',
    '  --base64    Treat input as base64-encoded license',
    '',
  ].join('\n'));
  process.exit(1);
};

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

const sha256hex = data => crypto.createHash('sha256').update(data).digest('hex');

const readLicenseInput = raw => {
  if (!raw) return null;
  if (fs.existsSync(raw)) return fs.readFileSync(raw, 'utf8').trim();
  return raw;
};

const parseAndDecode = raw => {
  const result = features.parseLicense(raw);
  if (result.reason === 'missing' || result.reason === 'invalid_format') {
    return { error: `Cannot parse license: ${result.reason}` };
  }
  return { envelope: result.parsed };
};

const safePayloadView = envelope => {
  if (!envelope || !envelope.payload) return null;
  const p = envelope.payload;
  return {
    customer: p.customer || null,
    plan: p.plan || null,
    features: Array.isArray(p.features) ? p.features : [],
    expires: p.expiresAt || p.expires || null,
    licenseId: p.licenseId || null,
    schemaVersion: p.schemaVersion || 1,
    algorithm: envelope.algorithm || 'HMAC-SHA256',
  };
};

const handleInspect = () => {
  const raw = readLicenseInput(argv._[1]);
  if (!raw) {
    process.stderr.write('Usage: node bin/license.js inspect <license-file-or-string>\n');
    process.exit(1);
  }

  const { envelope, error } = parseAndDecode(raw);
  if (error) {
    process.stderr.write(error + '\n');
    process.exit(1);
  }

  const view = safePayloadView(envelope);
  if (!view) {
    process.stderr.write('License has no payload.\n');
    process.exit(1);
  }

  console.log(JSON.stringify(view, null, 2));
};

const handleVerify = () => {
  const raw = readLicenseInput(argv._[1]);
  if (!raw) {
    process.stderr.write('Usage: node bin/license.js verify <license-file-or-string> [--public-key-file key.pem]\n');
    process.exit(1);
  }

  const { envelope, error } = parseAndDecode(raw);
  if (error) {
    process.stderr.write('PARSE ERROR: ' + error + '\n');
    process.exit(1);
  }

  const algorithm = String(envelope.algorithm || 'HMAC-SHA256').toUpperCase();

  if (algorithm === 'RSA-SHA256') {
    const publicKey = argv['public-key']
      || (argv['public-key-file'] ? fs.readFileSync(argv['public-key-file'], 'utf8').trim() : '')
      || features.getLicensePublicKey();

    if (!publicKey) {
      process.stderr.write('RSA verification requires --public-key-file or TIMEOFF_LICENSE_PUBLIC_KEY.\n');
      process.exit(1);
    }

    process.env.LEAVEPILOT_LICENSE_PUBLIC_KEY = publicKey;
    const result = features.verifyLicenseEnvelope(envelope, 'cli');

    if (!result.valid) {
      process.stderr.write('INVALID: ' + result.reason + '\n');
      process.exit(1);
    }

    const view = safePayloadView(envelope);
    console.log(JSON.stringify({ valid: true, reason: result.reason, ...view }, null, 2));
    return;
  }

  if (algorithm === 'HMAC-SHA256') {
    const secret = argv.secret || envResolver.resolve('LICENSE_SECRET');
    if (!secret) {
      process.stderr.write('HMAC verification requires --secret or TIMEOFF_LICENSE_SECRET.\n');
      process.exit(1);
    }

    process.env.LEAVEPILOT_LICENSE_SECRET = secret;
    const result = features.verifyLicenseEnvelope(envelope, 'cli');

    if (!result.valid) {
      process.stderr.write('INVALID: ' + result.reason + '\n');
      process.exit(1);
    }

    const view = safePayloadView(envelope);
    console.log(JSON.stringify({ valid: true, reason: result.reason, ...view }, null, 2));
    return;
  }

  process.stderr.write('Unsupported algorithm: ' + algorithm + '\n');
  process.exit(1);
};

const handlePlans = () => {
  const plans = features.planPresets;
  const lines = Object.keys(plans).map(name => {
    const p = plans[name];
    return `${name.padEnd(12)} ${p.description}\n              Features: ${p.features.length ? p.features.join(', ') : '(none — community defaults)'}`;
  });

  console.log('Available plan presets:\n');
  console.log(lines.join('\n\n'));
  console.log('\nRaw --features list always overrides plan presets.');
};

const handleGenerate = () => {
  if (!argv.customer) {
    process.stderr.write('Error: --customer is required.\n\n');
    process.stderr.write('Usage: node bin/license.js generate --customer "Name" --plan <plan> --private-key-file key.pem\n');
    process.exit(1);
  }

  const { spawnSync } = require('child_process');
  const generateArgs = ['--customer', argv.customer];

  if (argv.plan) generateArgs.push('--plan', argv.plan);
  if (argv.features) generateArgs.push('--features', argv.features);
  if (argv['private-key-file']) generateArgs.push('--private-key-file', argv['private-key-file']);
  if (argv['private-key']) generateArgs.push('--private-key', argv['private-key']);
  if (argv.secret) generateArgs.push('--secret', argv.secret);
  if (argv.expires) generateArgs.push('--expires', argv.expires);
  if (argv.base64) generateArgs.push('--base64');

  const result = spawnSync(process.execPath, ['bin/sign_license.js', ...generateArgs], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
  });

  if (result.status !== 0) {
    process.stderr.write(result.stderr || '');
    process.exit(result.status || 1);
  }

  const licenseOutput = (result.stdout || '').trim();

  if (argv.out) {
    const outPath = path.resolve(argv.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, licenseOutput + '\n');
    process.stderr.write('License written to ' + outPath + '\n');
  }

  if (argv.registry) {
    appendRegistry(licenseOutput, argv.out ? path.resolve(argv.out) : null);
  }

  if (!argv.out) {
    console.log(licenseOutput);
  }
};

const appendRegistry = (licenseOutput, outFilePath) => {
  const registryPath = path.resolve(argv.registry);
  let registry = [];

  fs.mkdirSync(path.dirname(registryPath), { recursive: true });

  if (fs.existsSync(registryPath)) {
    try {
      registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      if (!Array.isArray(registry)) {
        process.stderr.write('Error: registry file is not a JSON array: ' + registryPath + '\n');
        process.exit(1);
      }
    } catch (e) {
      process.stderr.write('Error: registry file is corrupt (invalid JSON): ' + registryPath + '\n');
      process.exit(1);
    }
  }

  const { envelope } = parseAndDecode(licenseOutput);
  if (!envelope || !envelope.payload) {
    process.stderr.write('Warning: cannot parse generated license for registry entry.\n');
    return;
  }

  const payload = envelope.payload;
  const entry = {
    customer: payload.customer || null,
    plan: payload.plan || null,
    features: Array.isArray(payload.features) ? payload.features : [],
    expires: payload.expiresAt || payload.expires || null,
    licenseId: payload.licenseId || null,
    algorithm: envelope.algorithm || 'HMAC-SHA256',
    issuedAt: new Date().toISOString(),
    issuedBy: process.env.USER || process.env.LOGNAME || 'unknown',
    payloadHash: sha256hex(canonicalJson(payload)),
    licenseHash: sha256hex(licenseOutput),
  };

  if (outFilePath) entry.outputFile = outFilePath;

  registry.push(entry);
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
  process.stderr.write('Registry updated: ' + registryPath + ' (' + registry.length + ' entries)\n');
};

const handleRegistry = () => {
  const registryPath = argv.registry ? path.resolve(argv.registry) : null;

  if (!registryPath || !fs.existsSync(registryPath)) {
    process.stderr.write('Registry file not found: ' + (registryPath || '(no --registry provided)') + '\n');
    process.exit(1);
  }

  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch (e) {
    process.stderr.write('Cannot parse registry file: ' + e.message + '\n');
    process.exit(1);
  }

  if (!Array.isArray(registry) || registry.length === 0) {
    console.log('Registry is empty.');
    return;
  }

  console.log(`Issued licenses (${registry.length}):\n`);
  registry.forEach((entry, i) => {
    const num = String(i + 1).padStart(3);
    const customer = (entry.customer || '(unknown)').padEnd(20);
    const plan = (entry.plan || '-').padEnd(12);
    const expires = entry.expires || 'never';
    const issued = entry.issuedAt || '?';
    console.log(`  ${num}. ${customer} plan=${plan} expires=${expires} issued=${issued}`);
    if (entry.payloadHash) console.log(`       payload: ${entry.payloadHash.substring(0, 16)}…`);
    if (entry.outputFile) console.log(`       file: ${entry.outputFile}`);
  });
};

const handlers = {
  inspect: handleInspect,
  verify: handleVerify,
  generate: handleGenerate,
  registry: handleRegistry,
  plans: handlePlans,
};

if (!subcommand || !handlers[subcommand]) {
  printUsageAndExit();
}

handlers[subcommand]();
