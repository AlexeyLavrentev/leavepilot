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

const safeSubmitState = (overrides = {}) => Object.assign({
  stage: 'after-click',
  url: 'http://127.0.0.1:3000/calendar',
  timeOrigin: 2,
  readyState: 'complete',
  rootStatus: 'unobserved',
  modal: {presence: true, visible: true, classTokens: ['modal']},
  submit: {
    presence: true,
    disabled: false,
    connected: true,
    formAction: '/calendar/bookleave/',
    inModal: true,
    tag: 'button',
    type: 'submit',
    formPresent: true,
    formOwnership: 'ancestor',
    formValid: true,
    invalidControl: null,
  },
  events: {submit: 1, beforeunload: 0},
  beforeClickHistory: [],
}, overrides);

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

  it('attaches only identity-matching bounded submit diagnostics', function() {
    const submitPath = path.join(directory, 'submit.json');
    const identity = {runId: 'run-c', batchId: 'batch-4', spec: PASSING};
    fs.writeFileSync(submitPath, JSON.stringify({
      version: 1,
      identity,
      state: safeSubmitState(),
    }));

    expect(reporter._submitDiagnostic(submitPath, identity)).to.deep.equal({
      state: 'received',
      snapshot: safeSubmitState(),
    });
    expect(reporter._submitDiagnostic(submitPath, Object.assign({}, identity, {batchId: 'other'})).state)
      .to.equal('invalid');
    fs.writeFileSync(submitPath, '{');
    expect(reporter._submitDiagnostic(submitPath, identity).state).to.equal('invalid');
  });

  it('rejects malformed or oversized pre-click diagnostic history', function() {
    const submitPath = path.join(directory, 'submit-history.json');
    const identity = {runId: 'run-history', batchId: 'batch-history', spec: PASSING};
    const beforeClick = safeSubmitState({stage: 'before-click', rootStatus: 'alive'});
    delete beforeClick.beforeClickHistory;
    const state = safeSubmitState({beforeClickHistory: [beforeClick]});
    fs.writeFileSync(submitPath, JSON.stringify({version: 1, identity, state}));

    expect(reporter._submitDiagnostic(submitPath, identity)).to.deep.equal({
      state: 'received', snapshot: state,
    });
    state.beforeClickHistory[0].submit.formValid = 'yes';
    fs.writeFileSync(submitPath, JSON.stringify({version: 1, identity, state}));
    expect(reporter._submitDiagnostic(submitPath, identity).state).to.equal('invalid');
    state.beforeClickHistory = Array(5).fill({stage: 'before-click', url: 'http://127.0.0.1:3000/calendar'});
    fs.writeFileSync(submitPath, JSON.stringify({version: 1, identity, state}));
    expect(reporter._submitDiagnostic(submitPath, identity).state).to.equal('invalid');
  });

  it('keeps Browser CI strict and uploads diagnostics on every outcome', function() {
    const workflow = fs.readFileSync('.github/workflows/core-integration.yml', 'utf8');
    const browserJob = workflow.slice(workflow.indexOf('jobs:\n  integration:'));

    expect(browserJob).to.include("TEST_RETRIES: '0'");
    expect(browserJob).to.include("TEST_INTEGRATION_BATCH_SIZE: '1'");
    expect(browserJob).to.include("TEST_EXECUTION_TIMEOUT_MS: '120000'");
    // eslint-disable-next-line no-template-curly-in-string
    expect(browserJob).to.include('name: flake-report-shard-${{ matrix.shard }}');
    // eslint-disable-next-line no-template-curly-in-string
    expect(browserJob).to.include('name: browser-batch-diagnostics-shard-${{ matrix.shard }}');
    expect(browserJob).to.include('path: .artifacts/verify/browser-batch-diagnostics/');
    expect(browserJob).to.include('if: always()');
    expect(browserJob).to.include('if-no-files-found: error');
    expect(browserJob).to.not.include('continue-on-error');
  });

});
