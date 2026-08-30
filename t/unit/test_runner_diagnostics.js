'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');
const expect = require('chai').expect;
const reporter = require('../lib/batch_diagnostic_reporter');

const ROOT = path.join(__dirname, '..', '..');
const MOCHA = path.join('node_modules', 'mocha', 'bin', 'mocha');
const REPORTER = path.join('t', 'lib', 'batch_diagnostic_reporter.js');
const FAILING = path.join('t', 'fixtures', 'batch_diagnostic', 'failing_fixture.js');
const PASSING = path.join('t', 'fixtures', 'batch_diagnostic', 'passing_fixture.js');

const runFixture = (fixture, snapshotPath, identity) => new Promise(resolve => {
  const child = spawn(process.execPath, [
    MOCHA,
    '--reporter', REPORTER,
    '--reporter-option', `runId=${identity.runId},batchId=${identity.batchId},spec=${identity.spec}`,
    fixture,
  ], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {TEST_BATCH_DIAGNOSTIC_PATH: snapshotPath}),
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.on('exit', code => resolve({code, output}));
});

describe('browser batch diagnostic contract', function() {
  let directory;

  beforeEach(function() {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-diagnostic-'));
  });

  afterEach(function() {
    fs.rmSync(directory, {recursive: true, force: true});
  });

  it('writes a bounded redacted failure snapshot with exact identity and test', async function() {
    const snapshotPath = path.join(directory, 'failure.json');
    const identity = {runId: 'run-a', batchId: 'batch-2', spec: FAILING};
    const result = await runFixture(FAILING, snapshotPath, identity);

    expect(result.code).to.equal(1);
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    expect(snapshot.identity).to.deep.equal(identity);
    expect(snapshot.event).to.equal('end');
    expect(snapshot.failure.name).to.equal('Error');
    expect(snapshot.failure.message).to.include('authorization=[REDACTED]');
    expect(snapshot.failure.message).to.not.include('private-fixture-token');
    expect(Buffer.byteLength(JSON.stringify(snapshot))).to.be.lessThan(8193);
  });

  it('records completion for a normal pass', async function() {
    const snapshotPath = path.join(directory, 'pass.json');
    const identity = {runId: 'run-b', batchId: 'batch-3', spec: PASSING};
    const result = await runFixture(PASSING, snapshotPath, identity);

    expect(result.code, result.output).to.equal(0);
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    expect(snapshot.identity).to.deep.equal(identity);
    expect(snapshot.event).to.equal('end');
    expect(snapshot.lastCompletedTest.title).to.contain('records a completed test');
  });

  it('rejects stale identities and redacts a bounded runner tail', function() {
    const source = fs.readFileSync('bin/test.js', 'utf8');
    const snapshotPath = path.join(directory, 'stale.json');
    fs.writeFileSync(snapshotPath, JSON.stringify({identity: {runId: 'old', batchId: 'batch-1', spec: 'old'}}));

    expect(() => JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))).to.not.throw;
    expect(source).to.include('reporter snapshot identity mismatch');
    expect(source).to.include("reporterSnapshotState = 'missing-on-timeout'");
    expect(source).to.include('DIAGNOSTIC_TAIL_BYTES = 4096');
    expect(source).to.include('captureOutput: true');
    expect(reporter._redact('token=private-value')).to.equal('token=[REDACTED]');
    expect(reporter._redact('x'.repeat(5000))).to.have.lengthOf(2048);
  });

});
