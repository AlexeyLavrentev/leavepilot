'use strict';

const {expect} = require('chai');
const {spawnSync} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {createWriter, readDiagnostics, validSnapshot, featureFlags} = require('../../../lib/verify/stage_diagnostic');

describe('stage failure reproduction', function() {
  this.timeout(10000);

  for (const [stage, event, title] of [
    ['test-diagnostic-fail', 'test-fail', 'fails before a later pass'],
    ['test-diagnostic-hang', 'test-start', 'hangs without a Mocha timeout'],
  ]) {
    it(`retains exact test identity for ${stage}`, () => {
      const result = spawnSync(process.execPath, ['bin/verify.js', '--stage', stage], {
        encoding: 'utf8', timeout: 9000,
        env: {...process.env, DB_PASSWORD: 'private-repro-value'},
      });
      expect(result.status, result.stderr).to.equal(1);
      const summary = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('VERIFY_SUMMARY ')).slice(15));
      expect(summary.schemaVersion).to.equal(3);
      const repro = summary.stages[0].attempts[0].reproduction;
      expect(repro.order).to.equal('runner-selected file order; Mocha declaration order; no randomization');
      expect(repro.seed).to.equal(null);
      expect(repro.replay).to.deep.equal({command: 'node', args: ['bin/verify.js', '--stage', stage]});
      expect(repro.shard).to.equal(null);
      const snapshot = stage.endsWith('fail') ? repro.diagnostics.firstFailure.snapshot : repro.diagnostics.latest.snapshot;
      expect(snapshot.event).to.equal(event);
      expect(snapshot.currentTest.title).to.include(title);
      expect(snapshot.currentTest.spec).to.equal('t/fixtures/verify/reproduction.js');
      expect(snapshot.runtime.nodeVersion).to.equal(process.version);
      expect(snapshot.runtime.browserVersion).to.equal(null);
      expect(snapshot.runtime.driverVersion).to.equal(null);
      expect(JSON.stringify(summary)).not.to.include('private-repro-value');
      if (stage.endsWith('fail')) {
        expect(repro.diagnostics.latest.snapshot.event).to.equal('end');
        expect(repro.diagnostics.latest.snapshot.lastCompletedTest.title).to.include('passes afterwards');
      } else {
        expect(summary.stages[0].failureClass).to.equal('timeout');
        expect(summary.stages[0].termination).to.be.an('object');
      }
    });
  }

  it('rejects malformed, stale, oversized and linked sidecars without copying their contents', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-diagnostic-'));
    const prefix = path.join(directory, 'stage');
    const file = `${prefix}.latest.json`;
    const env = {TEST_VERIFY_DIAGNOSTIC_PREFIX: prefix, TEST_VERIFY_DIAGNOSTIC_ID: 'run/stage'};
    const write = createWriter(env);
    try {
      expect(env).to.deep.equal({});
      write({event: 'end', currentTest: null, lastCompletedTest: null, failure: null});
      const snapshot = readDiagnostics(prefix, 'run/stage').latest.snapshot;
      expect(validSnapshot(snapshot, 'run/stage')).to.equal(true);
      expect(readDiagnostics(prefix, 'wrong').latest).to.deep.equal({state: 'invalid'});
      fs.writeFileSync(file, 'x'.repeat(20000));
      expect(readDiagnostics(prefix, 'run/stage').latest).to.deep.equal({state: 'invalid'});
      fs.unlinkSync(file);
      fs.symlinkSync(path.join(directory, 'absent'), file);
      expect(readDiagnostics(prefix, 'run/stage').latest).to.deep.equal({state: 'invalid'});
      fs.unlinkSync(file);
      fs.writeFileSync(path.join(directory, 'linked'), JSON.stringify(snapshot));
      fs.linkSync(path.join(directory, 'linked'), file);
      expect(readDiagnostics(prefix, 'run/stage').latest).to.deep.equal({state: 'invalid'});
      snapshot.currentTest = {title: 'token=private-repro-value', spec: 't/unit/a.js'};
      expect(validSnapshot(snapshot, 'run/stage')).to.equal(false);
    } finally { fs.rmSync(directory, {recursive: true, force: true}); }
  });

  it('records only allowlisted flag values, never arbitrary environment secrets', () => {
    const result = featureFlags({LEAVEPILOT_FEATURES: 'private-repro-value', DB_PASSWORD: 'private-repro-value'});
    expect(result.LEAVEPILOT_FEATURES).to.equal('unavailable');
    expect(JSON.stringify(result)).not.to.include('private-repro-value');
  });

  for (const kind of ['early-exit', 'retry']) {
    it(`does not certify an exit-zero ${kind}`, () => {
      const result = spawnSync(process.execPath, ['bin/verify.js', '--stage', `test-diagnostic-${kind}`], {encoding: 'utf8', timeout: 9000});
      expect(result.status, result.stderr).to.equal(1);
      const summary = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('VERIFY_SUMMARY ')).slice(15));
      expect(summary.stages[0]).to.include({status: 'failed', failureClass: 'runner error'});
      expect(summary.stages[0].reason).to.include('Missing or invalid stage completion diagnostics');
    });
  }
});
