'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {expect} = require('chai');
const redact = require('../../../lib/verify/diagnostic_text');

describe('persisted diagnostic secret safety', function() {
  this.timeout(10000);

  it('suppresses quoted, multiline, header, URL and escaped credential suffixes', function() {
    const secret = 'synthetic-sensitive-value';
    const cases = [
      JSON.stringify({password: secret + ' with spaces'}),
      JSON.stringify(JSON.stringify({password: secret})),
      `DB_PASSWORD='${secret} with spaces'`,
      `Authorization: Bearer ${secret}\nCookie: sid=second-secret`,
      `cookie: sid=${secret}; refresh=second-secret`,
      `secret: {\n  value: '${secret}'\n}`,
      `api_key=${secret}`, `token = ${secret}`, `key=${secret}`,
      `Bearer ${secret}`, `Basic ${secret}`,
      `mysql://user:${secret}@db.example/db`,
      `-----BEGIN PRIVATE KEY-----\n${secret}\n-----END PRIVATE KEY-----`,
    ];
    for (const input of cases) {
      const result = redact('failure context ' + input);
      expect(result).to.include('failure context');
      expect(result).to.include('[REDACTED]');
      expect(result).not.to.include(secret);
      expect(result).not.to.include('second-secret');
      // The runner repeatedly appends chunks to its already-redacted tail.
      const continued = redact(result + 'unlabelled-secret-continuation');
      expect(continued).not.to.include('unlabelled-secret-continuation');
    }
    expect(redact('expected 2 but got 1')).to.equal('expected 2 but got 1');
    const longIdentifier = 'a.'.repeat(20000);
    expect(redact(longIdentifier)).to.equal(longIdentifier);
  });

  it('removes structured credentials from actual verifier attempt and summary files', function() {
    const result = spawnSync(process.execPath, ['bin/verify.js', '--stage', 'test-secret-output'], {
      encoding: 'utf8', timeout: 8000,
    });
    expect(result.status).to.equal(1);
    const line = result.stdout.split('\n').find(value => value.startsWith('VERIFY_SUMMARY '));
    const summary = JSON.parse(line.slice('VERIFY_SUMMARY '.length));
    const attemptPath = summary.stages[0].attempts[0].evidence;
    for (const file of [attemptPath, path.join(path.dirname(attemptPath), 'summary.json')]) {
      const contents = fs.readFileSync(file, 'utf8');
      expect(contents).not.to.include('sentinel-json-secret');
      expect(contents).to.include('[REDACTED]');
      expect(contents).to.include('deliberate failure');
    }
  });

  it('removes credentials from real retry sidecars and batch failure snapshots', function() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-redaction-'));
    try {
      const sidecar = path.join(directory, 'sidecar.json');
      const snapshot = path.join(directory, 'snapshot.json');
      const result = spawnSync(process.execPath, [
        'node_modules/mocha/bin/mocha', '--retries', '1', '--reporter',
        't/lib/batch_diagnostic_reporter.js', 't/fixtures/verify/secret_failure.js',
      ], {
        encoding: 'utf8', timeout: 8000,
        env: {...process.env, FLAKE_ARTIFACT_PATH: sidecar, TEST_BATCH_DIAGNOSTIC_PATH: snapshot},
      });
      expect(result.status).to.equal(1);
      for (const file of [sidecar, snapshot]) {
        const contents = fs.readFileSync(file, 'utf8');
        expect(contents).not.to.include('sentinel-json-secret');
        expect(contents).to.include('[REDACTED]');
        expect(contents).to.include('deliberate failure');
      }
      expect(JSON.parse(fs.readFileSync(sidecar)).retries).to.have.lengthOf(1);
    } finally {
      fs.rmSync(directory, {recursive: true, force: true});
    }
  });
});
