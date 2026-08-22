'use strict';

const crypto = require('crypto');
const fs = require('fs');
const expect = require('chai').expect;
const { spawnSync } = require('child_process');
const path = require('path');

const binDir = path.join(__dirname, '..', '..', 'bin');
const node = process.execPath;

const runCli = (script, args, envOverrides) => {
  const result = spawnSync(node, [path.join(binDir, script), ...args], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, envOverrides || {}),
  });

  return {
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    status: result.status,
  };
};

const tmpFile = name => path.join(__dirname, name);

const cleanup = paths => {
  paths.forEach(p => {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
};

describe('License CLI', function() {
  let privateKey;
  let publicKey;

  before(function() {
    const keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
    privateKey = keyPair.privateKey.export({ type: 'pkcs1', format: 'pem' });
    publicKey = keyPair.publicKey.export({ type: 'pkcs1', format: 'pem' });
  });

  describe('sign_license.js with plan presets', function() {
    it('generates a license with --plan starter', function() {
      const result = runCli('sign_license.js', [
        '--customer', 'Test Corp',
        '--plan', 'starter',
        '--private-key', privateKey,
      ]);

      expect(result.status).to.equal(0);

      const envelope = JSON.parse(result.stdout);
      expect(envelope.algorithm).to.equal('RSA-SHA256');
      expect(envelope.payload.customer).to.equal('Test Corp');
      expect(envelope.payload.plan).to.equal('starter');
      expect(envelope.payload.features).to.deep.equal([]);
    });

    it('generates a license with --plan pro', function() {
      const result = runCli('sign_license.js', [
        '--customer', 'Acme Inc',
        '--plan', 'pro',
        '--private-key', privateKey,
        '--expires', '2027-12-31',
      ]);

      expect(result.status).to.equal(0);

      const envelope = JSON.parse(result.stdout);
      expect(envelope.payload.plan).to.equal('pro');
      expect(envelope.payload.features).to.include('sso_authentication');
      expect(envelope.payload.features).to.include('integration_api');
      expect(envelope.payload.features).to.include('employee_groups');
      expect(envelope.payload.features).to.include('work_calendars');
      expect(envelope.payload.expiresAt).to.equal('2027-12-31');
      expect(envelope.payload.schemaVersion).to.equal(2);
      expect(envelope.payload.licenseId).to.be.a('string').and.not.empty;
    });

    it('generates a license with --plan enterprise', function() {
      const result = runCli('sign_license.js', [
        '--customer', 'BigCo',
        '--plan', 'enterprise',
        '--private-key', privateKey,
      ]);

      expect(result.status).to.equal(0);

      const envelope = JSON.parse(result.stdout);
      expect(envelope.payload.plan).to.equal('enterprise');
      expect(envelope.payload.features.length).to.be.greaterThan(4);
      expect(envelope.payload.features).to.include('time_balance');
      expect(envelope.payload.features).to.include('vacation_planning');
    });

    it('rejects unknown plan name', function() {
      const result = runCli('sign_license.js', [
        '--customer', 'Test',
        '--plan', 'nonexistent',
        '--private-key', privateKey,
      ]);

      expect(result.status).to.not.equal(0);
      expect(result.stderr).to.contain('Unknown plan');
    });
  });

  describe('sign_license.js with --features', function() {
    it('generates a valid RSA license', function() {
      const result = runCli('sign_license.js', [
        '--customer', 'Test Corp',
        '--features', 'sso_authentication,integration_api',
        '--private-key', privateKey,
      ]);

      expect(result.status).to.equal(0);

      const envelope = JSON.parse(result.stdout);
      expect(envelope.algorithm).to.equal('RSA-SHA256');
      expect(envelope.payload.customer).to.equal('Test Corp');
      expect(envelope.payload.features).to.deep.equal(['sso_authentication', 'integration_api']);
    });

    it('generates base64 output when --base64 is set', function() {
      const result = runCli('sign_license.js', [
        '--customer', 'Test',
        '--features', 'sso_authentication',
        '--private-key', privateKey,
        '--base64',
      ]);

      expect(result.status).to.equal(0);

      const decoded = JSON.parse(Buffer.from(result.stdout, 'base64').toString('utf8'));
      expect(decoded.algorithm).to.equal('RSA-SHA256');
    });
  });

  describe('license.js generate', function() {
    it('fails without --customer', function() {
      const result = runCli('license.js', [
        'generate',
        '--plan', 'pro',
        '--private-key', privateKey,
      ]);

      expect(result.status).to.not.equal(0);
      expect(result.stderr).to.contain('--customer is required');
    });

    it('writes license to --out file', function() {
      const outFile = tmpFile('tmp_out_license.json');

      try {
        const result = runCli('license.js', [
          'generate',
          '--customer', 'OutTest',
          '--features', 'sso_authentication',
          '--private-key', privateKey,
          '--out', outFile,
        ]);

        expect(result.status).to.equal(0);
        expect(fs.existsSync(outFile)).to.equal(true);

        const content = fs.readFileSync(outFile, 'utf8');
        const envelope = JSON.parse(content);
        expect(envelope.payload.customer).to.equal('OutTest');
      } finally {
        cleanup([outFile]);
      }
    });

    it('generated --out file verifies with public key', function() {
      const outFile = tmpFile('tmp_verify_out.json');

      try {
        runCli('license.js', [
          'generate',
          '--customer', 'VerifyOut',
          '--features', 'sso_authentication',
          '--private-key', privateKey,
          '--expires', '2028-12-31',
          '--out', outFile,
        ]);

        const verifyResult = runCli('license.js', [
          'verify', outFile,
          '--public-key', publicKey,
        ]);

        expect(verifyResult.status).to.equal(0);

        const result = JSON.parse(verifyResult.stdout);
        expect(result.valid).to.equal(true);
        expect(result.customer).to.equal('VerifyOut');
      } finally {
        cleanup([outFile]);
      }
    });
  });

  describe('license.js registry', function() {
    it('creates registry and appends entries', function() {
      const regFile = tmpFile('tmp_registry.json');

      try {
        runCli('license.js', [
          'generate',
          '--customer', 'RegCorp',
          '--plan', 'pro',
          '--private-key', privateKey,
          '--expires', '2027-06-01',
          '--registry', regFile,
        ]);

        expect(fs.existsSync(regFile)).to.equal(true);

        const registry = JSON.parse(fs.readFileSync(regFile, 'utf8'));
        expect(registry).to.be.an('array');
        expect(registry.length).to.equal(1);

        const entry = registry[0];
        expect(entry.customer).to.equal('RegCorp');
        expect(entry.plan).to.equal('pro');
        expect(entry.features).to.include('sso_authentication');
        expect(entry.expires).to.equal('2027-06-01');
        expect(entry.algorithm).to.equal('RSA-SHA256');
        expect(entry.issuedAt).to.be.a('string');
        expect(entry.payloadHash).to.be.a('string');
        expect(entry.payloadHash).to.have.length(64);
        expect(entry.licenseHash).to.be.a('string');
        expect(entry.licenseHash).to.have.length(64);
      } finally {
        cleanup([regFile]);
      }
    });

    it('appends to existing registry', function() {
      const regFile = tmpFile('tmp_registry_append.json');

      try {
        runCli('license.js', [
          'generate',
          '--customer', 'First',
          '--features', 'sso_authentication',
          '--private-key', privateKey,
          '--registry', regFile,
        ]);

        runCli('license.js', [
          'generate',
          '--customer', 'Second',
          '--features', 'integration_api',
          '--private-key', privateKey,
          '--registry', regFile,
        ]);

        const registry = JSON.parse(fs.readFileSync(regFile, 'utf8'));
        expect(registry.length).to.equal(2);
        expect(registry[0].customer).to.equal('First');
        expect(registry[1].customer).to.equal('Second');
      } finally {
        cleanup([regFile]);
      }
    });

    it('registry entry does not contain private key material', function() {
      const regFile = tmpFile('tmp_registry_safe.json');

      try {
        runCli('license.js', [
          'generate',
          '--customer', 'SafeCorp',
          '--features', 'sso_authentication',
          '--private-key', privateKey,
          '--registry', regFile,
        ]);

        const content = fs.readFileSync(regFile, 'utf8');
        expect(content).to.not.contain('PRIVATE');
        expect(content).to.not.contain('-----BEGIN');
        expect(content).to.not.contain(privateKey.substring(0, 30));

        const registry = JSON.parse(content);
        const entry = registry[0];
        expect(entry.signature).to.equal(undefined);
        expect(entry.privateKey).to.equal(undefined);
      } finally {
        cleanup([regFile]);
      }
    });

    it('registry entry does not contain raw license blob', function() {
      const regFile = tmpFile('tmp_registry_noblob.json');

      try {
        runCli('license.js', [
          'generate',
          '--customer', 'NoBlobCorp',
          '--features', 'sso_authentication',
          '--private-key', privateKey,
          '--registry', regFile,
        ]);

        const registry = JSON.parse(fs.readFileSync(regFile, 'utf8'));
        const entry = registry[0];
        expect(entry.license).to.equal(undefined);
        expect(entry.envelope).to.equal(undefined);
        expect(entry.licenseBlob).to.equal(undefined);
        expect(entry.payloadHash).to.be.a('string');
        expect(entry.licenseHash).to.be.a('string');
      } finally {
        cleanup([regFile]);
      }
    });

    it('registry with --out stores output file path', function() {
      const regFile = tmpFile('tmp_registry_with_out.json');
      const licFile = tmpFile('tmp_registry_lic.json');

      try {
        runCli('license.js', [
          'generate',
          '--customer', 'OutRegCorp',
          '--features', 'sso_authentication',
          '--private-key', privateKey,
          '--out', licFile,
          '--registry', regFile,
        ]);

        const registry = JSON.parse(fs.readFileSync(regFile, 'utf8'));
        expect(registry[0].outputFile).to.be.a('string');
        expect(registry[0].outputFile).to.contain('tmp_registry_lic.json');
      } finally {
        cleanup([regFile, licFile]);
      }
    });

    it('registry subcommand lists entries', function() {
      const regFile = tmpFile('tmp_registry_list.json');

      try {
        runCli('license.js', [
          'generate',
          '--customer', 'ListCorp',
          '--plan', 'enterprise',
          '--private-key', privateKey,
          '--expires', '2028-01-01',
          '--registry', regFile,
        ]);

        const result = runCli('license.js', ['registry', '--registry', regFile]);

        expect(result.status).to.equal(0);
        expect(result.stdout).to.contain('ListCorp');
        expect(result.stdout).to.contain('enterprise');
        expect(result.stdout).to.contain('2028-01-01');
      } finally {
        cleanup([regFile]);
      }
    });

    it('registry subcommand handles empty registry', function() {
      const regFile = tmpFile('tmp_registry_empty.json');
      fs.writeFileSync(regFile, '[]');

      try {
        const result = runCli('license.js', ['registry', '--registry', regFile]);
        expect(result.status).to.equal(0);
        expect(result.stdout).to.contain('empty');
      } finally {
        cleanup([regFile]);
      }
    });

    it('registry subcommand fails on missing file', function() {
      const result = runCli('license.js', ['registry', '--registry', '/nonexistent/path.json']);
      expect(result.status).to.not.equal(0);
      expect(result.stderr).to.contain('not found');
    });

    it('refuses to overwrite a corrupt registry file', function() {
      const regFile = tmpFile('tmp_registry_corrupt.json');

      try {
        fs.writeFileSync(regFile, '{not valid json[');

        const result = runCli('license.js', [
          'generate',
          '--customer', 'CorruptTest',
          '--features', 'sso_authentication',
          '--private-key', privateKey,
          '--registry', regFile,
        ]);

        expect(result.status).to.not.equal(0);
        expect(result.stderr).to.contain('corrupt');
        expect(fs.readFileSync(regFile, 'utf8')).to.equal('{not valid json[');
      } finally {
        cleanup([regFile]);
      }
    });

    it('refuses to overwrite a registry file that is not an array', function() {
      const regFile = tmpFile('tmp_registry_notarray.json');

      try {
        fs.writeFileSync(regFile, '{"not":"an array"}');

        const result = runCli('license.js', [
          'generate',
          '--customer', 'NotArrayTest',
          '--features', 'sso_authentication',
          '--private-key', privateKey,
          '--registry', regFile,
        ]);

        expect(result.status).to.not.equal(0);
        expect(result.stderr).to.contain('not a JSON array');
        expect(JSON.parse(fs.readFileSync(regFile, 'utf8'))).to.deep.equal({ not: 'an array' });
      } finally {
        cleanup([regFile]);
      }
    });

    it('creates parent directories for --out', function() {
      const outDir = tmpFile('tmp_nested_out_' + Date.now());
      const outFile = path.join(outDir, 'sub', 'license.json');

      try {
        const result = runCli('license.js', [
          'generate',
          '--customer', 'NestedOut',
          '--features', 'sso_authentication',
          '--private-key', privateKey,
          '--out', outFile,
        ]);

        expect(result.status).to.equal(0);
        expect(fs.existsSync(outFile)).to.equal(true);

        const envelope = JSON.parse(fs.readFileSync(outFile, 'utf8'));
        expect(envelope.payload.customer).to.equal('NestedOut');
      } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    });

    it('creates parent directories for --registry', function() {
      const regDir = tmpFile('tmp_nested_reg_' + Date.now());
      const regFile = path.join(regDir, 'sub', 'registry.json');

      try {
        const result = runCli('license.js', [
          'generate',
          '--customer', 'NestedReg',
          '--features', 'sso_authentication',
          '--private-key', privateKey,
          '--registry', regFile,
        ]);

        expect(result.status).to.equal(0);
        expect(fs.existsSync(regFile)).to.equal(true);

        const registry = JSON.parse(fs.readFileSync(regFile, 'utf8'));
        expect(registry[0].customer).to.equal('NestedReg');
      } finally {
        fs.rmSync(regDir, { recursive: true, force: true });
      }
    });
  });

  describe('license.js inspect', function() {
    it('inspects a license without needing private key', function() {
      const generateResult = runCli('sign_license.js', [
        '--customer', 'InspectMe',
        '--features', 'sso_authentication,integration_api',
        '--private-key', privateKey,
        '--expires', '2028-06-01',
      ]);

      expect(generateResult.status).to.equal(0);

      const inspectResult = runCli('license.js', ['inspect', generateResult.stdout]);

      expect(inspectResult.status).to.equal(0);

      const view = JSON.parse(inspectResult.stdout);
      expect(view.customer).to.equal('InspectMe');
      expect(view.features).to.deep.equal(['sso_authentication', 'integration_api']);
      expect(view.expires).to.equal('2028-06-01');
      expect(view.algorithm).to.equal('RSA-SHA256');
    });

    it('never exposes private key material in inspect output', function() {
      const generateResult = runCli('sign_license.js', [
        '--customer', 'SecurityTest',
        '--features', 'sso_authentication',
        '--private-key', privateKey,
      ]);

      const inspectResult = runCli('license.js', ['inspect', generateResult.stdout]);

      expect(inspectResult.status).to.equal(0);
      expect(inspectResult.stdout).to.not.contain('PRIVATE');
      expect(inspectResult.stdout).to.not.contain('-----BEGIN');
      expect(inspectResult.stdout).to.not.contain(privateKey.substring(0, 30));
    });

    it('never exposes signature in inspect output', function() {
      const generateResult = runCli('sign_license.js', [
        '--customer', 'SecurityTest',
        '--features', 'sso_authentication',
        '--private-key', privateKey,
      ]);

      const envelope = JSON.parse(generateResult.stdout);
      const inspectResult = runCli('license.js', ['inspect', generateResult.stdout]);

      expect(inspectResult.status).to.equal(0);
      expect(inspectResult.stdout).to.not.contain(envelope.signature);
      expect(inspectResult.stdout).to.not.contain('signature');
    });

    it('reads license from file', function() {
      const testFile = tmpFile('tmp_test_license.json');

      try {
        const generateResult = runCli('sign_license.js', [
          '--customer', 'FileTest',
          '--features', 'sso_authentication',
          '--private-key', privateKey,
        ]);

        fs.writeFileSync(testFile, generateResult.stdout);

        const inspectResult = runCli('license.js', ['inspect', testFile]);

        expect(inspectResult.status).to.equal(0);

        const view = JSON.parse(inspectResult.stdout);
        expect(view.customer).to.equal('FileTest');
      } finally {
        cleanup([testFile]);
      }
    });

    it('inspects plan preset licenses', function() {
      const generateResult = runCli('sign_license.js', [
        '--customer', 'PlanTest',
        '--plan', 'enterprise',
        '--private-key', privateKey,
      ]);

      expect(generateResult.status).to.equal(0);

      const inspectResult = runCli('license.js', ['inspect', generateResult.stdout]);

      expect(inspectResult.status).to.equal(0);

      const view = JSON.parse(inspectResult.stdout);
      expect(view.plan).to.equal('enterprise');
      expect(view.features).to.include('time_balance');
    });
  });

  describe('license.js verify', function() {
    it('verifies a valid RSA license', function() {
      const generateResult = runCli('sign_license.js', [
        '--customer', 'VerifyMe',
        '--features', 'sso_authentication',
        '--private-key', privateKey,
      ]);

      expect(generateResult.status).to.equal(0);

      const verifyResult = runCli('license.js', [
        'verify',
        generateResult.stdout,
        '--public-key', publicKey,
      ]);

      expect(verifyResult.status).to.equal(0);

      const result = JSON.parse(verifyResult.stdout);
      expect(result.valid).to.equal(true);
      expect(result.customer).to.equal('VerifyMe');
    });

    it('rejects a tampered payload', function() {
      const generateResult = runCli('sign_license.js', [
        '--customer', 'TamperTest',
        '--features', 'sso_authentication',
        '--private-key', privateKey,
      ]);

      expect(generateResult.status).to.equal(0);

      const envelope = JSON.parse(generateResult.stdout);
      envelope.payload.features.push('integration_api');
      const tampered = JSON.stringify(envelope);

      const verifyResult = runCli('license.js', [
        'verify',
        tampered,
        '--public-key', publicKey,
      ]);

      expect(verifyResult.status).to.not.equal(0);
      expect(verifyResult.stderr).to.contain('INVALID');
    });

    it('rejects an expired license', function() {
      const generateResult = runCli('sign_license.js', [
        '--customer', 'ExpiredTest',
        '--features', 'sso_authentication',
        '--private-key', privateKey,
        '--expires', '2000-01-01',
      ]);

      expect(generateResult.status).to.equal(0);

      const verifyResult = runCli('license.js', [
        'verify',
        generateResult.stdout,
        '--public-key', publicKey,
      ]);

      expect(verifyResult.status).to.not.equal(0);
      expect(verifyResult.stderr).to.contain('expired');
    });

    it('fails gracefully with mismatched public key', function() {
      const generateResult = runCli('sign_license.js', [
        '--customer', 'NoKeyTest',
        '--features', 'sso_authentication',
        '--private-key', privateKey,
      ]);

      // Hardcoded public key is always available as fallback, so "missing key"
      // is no longer possible. Instead, the signature won't match the hardcoded key.
      const verifyResult = runCli('license.js', [
        'verify',
        generateResult.stdout,
      ], { TIMEOFF_LICENSE_PUBLIC_KEY: '' });

      expect(verifyResult.status).to.not.equal(0);
      expect(verifyResult.stderr).to.contain('signature');
    });
  });

  describe('license.js plans', function() {
    it('lists all plan presets', function() {
      const result = runCli('license.js', ['plans']);

      expect(result.status).to.equal(0);
      expect(result.stdout).to.contain('starter');
      expect(result.stdout).to.contain('pro');
      expect(result.stdout).to.contain('enterprise');
    });
  });

  describe('sign_revocation_list.js', function() {
    it('generates a signed offline revocation list', function() {
      const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const result = runCli('sign_revocation_list.js', [
        '--revoked', 'lic-b,lic-a,lic-a',
        '--expires', expires,
        '--private-key', privateKey,
      ]);

      expect(result.status).to.equal(0);
      const envelope = JSON.parse(result.stdout);
      expect(envelope.algorithm).to.equal('RSA-SHA256');
      expect(envelope.payload.schemaVersion).to.equal(1);
      expect(envelope.payload.revokedLicenseIds).to.deep.equal(['lic-a', 'lic-b']);
      expect(envelope.payload.expiresAt).to.equal(expires);
      expect(envelope.signature).to.be.a('string').and.not.empty;
    });

    it('rejects an expired revocation list', function() {
      const result = runCli('sign_revocation_list.js', [
        '--expires', '2000-01-01T00:00:00.000Z',
        '--private-key', privateKey,
      ]);

      expect(result.status).to.not.equal(0);
      expect(result.stderr).to.contain('future ISO date');
    });
  });
});
