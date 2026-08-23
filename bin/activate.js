#!/usr/bin/env node

'use strict';

const fs = require('fs');
const _path = require('path');
const minimist = require('minimist');
const { writeLicenseFile, getLicenseFilePath } = require('../lib/license_storage');
const { generateFingerprint } = require('../lib/machine_fingerprint');
const features = require('../lib/features');

const argv = minimist(process.argv.slice(2));

const printUsageAndExit = () => {
  process.stderr.write([
    'LeavePilot License Activation CLI',
    '',
    'Usage:',
    '  node bin/activate.js <token> --portal <url>     Online activation with token',
    '  node bin/activate.js --offline                   Generate offline activation request',
    '  node bin/activate.js --license-file <file>       Activate from license file',
    '  node bin/activate.js status                      Show current license status',
    '',
    'Online activation:',
    '  <token>              Activation token from portal',
    '  --portal <url>       Portal URL (e.g. http://localhost:3001)',
    '  --machine-id <id>    Machine fingerprint (auto-generated if not provided)',
    '',
    'Offline activation:',
    '  --offline            Generate offline activation request JSON',
    '  --out <file>         Write request to file (default: activation-request.json)',
    '',
    'License file:',
    '  --license-file <file>  Path to license JSON file',
    '',
    'Status:',
    '  node bin/activate.js status                      Show current license status',
    '',
  ].join('\n'));
  process.exit(1);
};

const subcommand = argv._[0];

// Status subcommand
if (subcommand === 'status') {
  const status = features.getLicenseStatus();
  process.stdout.write(JSON.stringify(status, null, 2) + '\n');
  process.exit(0);
}

// Offline activation
if (argv.offline) {
  const fingerprint = generateFingerprint();

  if (!fingerprint) {
    process.stderr.write('Error: could not generate machine fingerprint.\n');
    process.exit(1);
  }

  const request = {
    type: 'leavepilot-offline-activation-request',
    version: 1,
    machineId: fingerprint,
    timestamp: new Date().toISOString(),
    hostname: require('os').hostname(),
  };

  const outFile = argv.out || 'activation-request.json';
  fs.writeFileSync(outFile, JSON.stringify(request, null, 2) + '\n', 'utf8');

  process.stdout.write('Offline activation request written to: ' + outFile + '\n');
  process.stdout.write('Machine ID: ' + fingerprint + '\n');
  process.stdout.write('\n');
  process.stdout.write('Next steps:\n');
  process.stdout.write('  1. Transfer ' + outFile + ' to a machine with internet access\n');
  process.stdout.write('  2. Submit the request to the portal admin\n');
  process.stdout.write('  3. Download the license file from the portal\n');
  process.stdout.write('  4. Run: node bin/activate.js --license-file <downloaded-file>\n');
  process.exit(0);
}

// License file activation
if (argv['license-file']) {
  const licensePath = argv['license-file'];

  if (!fs.existsSync(licensePath)) {
    process.stderr.write('Error: license file not found: ' + licensePath + '\n');
    process.exit(1);
  }

  const licenseContent = fs.readFileSync(licensePath, 'utf8').trim();

  // Verify the license
  const parsed = features.parseLicense(licenseContent);
  if (parsed.reason !== 'parsed') {
    process.stderr.write('Error: invalid license file format: ' + parsed.reason + '\n');
    process.exit(1);
  }

  const envelope = parsed.parsed;
  const status = features.verifyLicenseEnvelope(envelope, 'file');

  if (!status.valid) {
    process.stderr.write('Error: license verification failed: ' + status.reason + '\n');
    process.exit(1);
  }

  // Check machine fingerprint if present
  const payload = envelope.payload || {};
  if (payload.machineFingerprint) {
    const currentFingerprint = generateFingerprint();

    if (currentFingerprint && currentFingerprint !== payload.machineFingerprint) {
      process.stderr.write('Error: license machine fingerprint does not match this machine.\n');
      process.stderr.write('  Expected: ' + payload.machineFingerprint + '\n');
      process.stderr.write('  Current:  ' + currentFingerprint + '\n');
      process.exit(1);
    }
  }

  // Save to license file
  const saved = writeLicenseFile(licenseContent);

  if (!saved) {
    process.stderr.write('Error: could not save license file.\n');
    process.exit(1);
  }

  const licenseFilePath = getLicenseFilePath();
  process.stdout.write('License activated and saved to: ' + licenseFilePath + '\n');
  process.stdout.write('License ID: ' + (status.payload.licenseId || 'unknown') + '\n');
  process.stdout.write('Customer: ' + (status.payload.customerName || 'unknown') + '\n');
  process.stdout.write('Plan: ' + (status.payload.plan || 'none') + '\n');
  process.stdout.write('Features: ' + (status.payload.features || []).join(', ') + '\n');

  if (status.payload.expiresAt) {
    process.stdout.write('Expires: ' + status.payload.expiresAt + '\n');
  } else {
    process.stdout.write('Expires: never (permanent)\n');
  }

  process.exit(0);
}

// Online activation
const token = subcommand;
const portalUrl = argv.portal;

if (!token) {
  printUsageAndExit();
}

if (!portalUrl) {
  process.stderr.write('Error: --portal <url> is required for online activation.\n');
  process.exit(1);
}

const fingerprint = generateFingerprint();

if (!fingerprint) {
  process.stderr.write('Error: could not generate machine fingerprint.\n');
  process.exit(1);
}

const activate = async () => {
  try {
    // Simple cookie jar for session management
    const cookies = {};
    const cookieHeader = () => Object.entries(cookies).map(([k, v]) => k + '=' + v).join('; ');
    const saveCookies = response => {
      const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
      for (const cookie of setCookies) {
        const [pair] = cookie.split(';');
        const [name, ...valueParts] = pair.split('=');
        cookies[name.trim()] = valueParts.join('=').trim();
      }
    };

    // Get CSRF token (requires session cookie)
    const csrfResponse = await fetch(portalUrl + '/api/v1/auth/csrf', {
      method: 'GET',
      headers: { 'Cookie': cookieHeader() },
    });
    saveCookies(csrfResponse);

    if (!csrfResponse.ok) {
      process.stderr.write('Error: could not get CSRF token from portal (status ' + csrfResponse.status + ').\n');
      process.exit(1);
    }

    const csrfData = await csrfResponse.json();
    const csrfToken = csrfData.csrfToken;

    // Activate license
    const activateResponse = await fetch(portalUrl + '/api/v1/activate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken,
        'Cookie': cookieHeader(),
      },
      body: JSON.stringify({
        token: token,
        machineId: argv['machine-id'] || fingerprint,
      }),
    });

    if (!activateResponse.ok) {
      const errorData = await activateResponse.json().catch(() => ({}));
      process.stderr.write('Error: activation failed: ' + (errorData.error || activateResponse.statusText) + '\n');
      process.exit(1);
    }

    const result = await activateResponse.json();
    const envelope = result.envelope;

    // Save license
    const saved = writeLicenseFile(JSON.stringify(envelope, null, 2));

    if (!saved) {
      process.stderr.write('Error: could not save license file.\n');
      process.exit(1);
    }

    const licenseFilePath = getLicenseFilePath();
    process.stdout.write('License activated and saved to: ' + licenseFilePath + '\n');
    process.stdout.write('License ID: ' + (envelope.payload.licenseId || 'unknown') + '\n');
    process.stdout.write('Customer: ' + (envelope.payload.customerName || 'unknown') + '\n');
    process.stdout.write('Plan: ' + (envelope.payload.plan || 'none') + '\n');
    process.stdout.write('Features: ' + (envelope.payload.features || []).join(', ') + '\n');

    if (envelope.payload.expiresAt) {
      process.stdout.write('Expires: ' + envelope.payload.expiresAt + '\n');
    } else {
      process.stdout.write('Expires: never (permanent)\n');
    }
  } catch (error) {
    process.stderr.write('Error: ' + error.message + '\n');
    process.exit(1);
  }
};

activate();
