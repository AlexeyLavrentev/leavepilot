'use strict';

// Repository-only calibration: reuse the real runner, scenario and process
// ownership implementation. Each observation is a new process/browser/database.
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const {execFileSync} = require('child_process');
const {once} = require('events');
const {spawnInGroup, terminateGroup, terminateTree} = require('../bin/lib/spawn_group');
const createChildOutput = require('../lib/verify/child_output');
const redact = require('../lib/util/diagnostic_text');
const browserSetup = require('../bin/browser_setup');
const sqlite3 = require('sqlite3');

const SPEC = 't/integration/leave_request/basic_leave_request.js';
const ARGS = ['bin/test.js', SPEC, '--grep=^Basic leave request', '--reporter=t/lib/approval_stress_reporter.js'];
const BUDGET_MS = 30000;
const CAP = 25;
const requireTrue = (condition, message) => { if (!condition) { throw new Error(message); } };
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {flag: 'wx', mode: 0o600});
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const sourceState = () => {
  const git = args => execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024});
  return {headSha: git(['rev-parse', 'HEAD']).trim(), trackedDiffSha: sha(git(['diff', 'HEAD'])), clean: git(['status', '--porcelain']).trim() === ''};
};

function selectIterations(samples) {
  requireTrue(samples.length >= 3 && samples.every(value => Number.isFinite(value) && value > 0), 'Three positive calibration samples required');
  const count = Math.min(CAP, Math.floor(BUDGET_MS / Math.max(...samples)));
  requireTrue(count >= 1, 'No repetition fits the measured stress budget');
  return count;
}

function validateObservation(value) {
  requireTrue(value && value.tests === 22 && value.passes === 22 && value.failures === 0 && value.pending === 0 && value.retries === 0 && value.approvalActionPassed === true && value.employeeCalendarCheckPassed === true, 'Missing complete first-attempt approval observation');
}

async function approvedRow(storage) {
  const db = await new Promise((resolve, reject) => {
    const connection = new sqlite3.Database(storage, sqlite3.OPEN_READONLY, error => error ? reject(error) : resolve(connection));
  });
  try {
    const rows = await new Promise((resolve, reject) => db.all(
      'SELECT l.status, l.date_start, l.date_end, l.day_part_start, l.day_part_end, l.decided_at, a.admin AS approver_admin, a.companyId = u.companyId AS same_company FROM Leaves l JOIN Users u ON u.id = l.userId LEFT JOIN Users a ON a.id = l.approverId',
      (error, values) => error ? reject(error) : resolve(values)
    ));
    requireTrue(rows.length === 1, 'Expected exactly one persisted approval');
    const row = rows[0];
    // The current approval contract persists status/approver, not decided_at.
    requireTrue(row.status === 2 && row.approver_admin === 1 && row.same_company === 1, 'Approval decision or approver was not persisted');
    requireTrue(row.date_start.startsWith('2015-06-15') && row.date_end.startsWith('2015-06-16') && row.day_part_start === 2 && row.day_part_end === 1, 'Unexpected persisted leave dates/halves');
    return row;
  } finally {
    await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
  }
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return String(port);
}

async function main() {
  requireTrue(/^v22\./.test(process.version), 'Use the declared Node 22 runtime');
  const browser = await browserSetup.validate();
  const directory = fs.mkdtempSync(path.resolve('.artifacts/verify/approval-stress-'));
  const report = {
    schemaVersion: 1, startedAt: new Date().toISOString(), source: {start: sourceState()},
    command: 'node scripts/measure_approval_stress.js', scriptSha: sha(fs.readFileSync(__filename)),
    scenarioSha: sha(fs.readFileSync(SPEC)), reporterSha: sha(fs.readFileSync('t/lib/approval_stress_reporter.js')),
    reproduction: {command: process.execPath, args: ARGS, nodeVersion: process.version, platform: process.platform, architecture: process.arch, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      browserVersion: browser.chromeVersion, driverVersion: browser.chromedriverVersion, headless: true, viewport: {width: 1024, height: 768}, dbContour: 'sqlite', featureFlags: 'all', retries: 0, shard: null, order: 'declaration', seed: 'not randomized; fixture dates 2015-06-15/16; generated account names use wall-clock milliseconds'},
    selectionRule: 'min(25, floor(30000 / max(three independent CLI durations)))', budgetMs: BUDGET_MS,
    calibration: [], stress: [], status: 'running',
  };
  let interrupted = false;
  let stopActive;
  const onSignal = () => { interrupted = true; if (stopActive) { stopActive(); } };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  async function trial(kind, index) {
    requireTrue(!interrupted, 'Measurement interrupted');
    const trialDir = path.join(directory, `${kind}-${index}`);
    fs.mkdirSync(trialDir);
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-stress-db-'));
    const processReport = path.join(trialDir, 'processes.json');
    const observationPath = path.join(trialDir, 'observation.json');
    const env = {...process.env, PORT: await freePort(), TEST_HOST: '127.0.0.1', TEST_DB_DIALECT: 'sqlite', TEST_DB_STORAGE: path.join(storageDir, 'test.sqlite'), TEST_RETRIES: '0', TEST_EXECUTION_TIMEOUT_MS: '120000', TEST_EXPLICIT_PATH_TIMEOUT_MS: '300000', TEST_ENFORCE_SKIP_HONESTY: 'true', TEST_CANONICAL_VERIFY: 'true', TEST_PROCESS_REPORT_PATH: processReport, APPROVAL_STRESS_REPORT_PATH: observationPath, SHOW_CHROME: '', NO_COLOR: '1', FORCE_COLOR: '0'};
    const record = {kind, index, startedAt: new Date().toISOString(), status: 'failed', port: env.PORT};
    const log = fs.openSync(path.join(trialDir, 'runner.log'), 'wx', 0o600);
    const emit = text => { fs.writeSync(log, text); };
    const filter = createChildOutput({stdout: emit, stderr: emit});
    const start = performance.now();
    let termination;
    let timer;
    try {
      const child = spawnInGroup(process.execPath, ARGS, {env, stdio: ['ignore', 'pipe', 'pipe']});
      stopActive = () => { termination ||= terminateTree(child); return termination; };
      // Retain the existing outer browser-stage ceiling; inner Mocha already
      // has its original explicit-path timeout and process-group cleanup.
      timer = setTimeout(stopActive, 1800000);
      child.stdout.on('data', chunk => filter.write('stdout', chunk));
      child.stderr.on('data', chunk => filter.write('stderr', chunk));
      const [code, signal] = await once(child, 'close');
      const sweep = termination ? await termination : await terminateGroup(child, {graceMs: 0});
      filter.end();
      record.durationMs = Math.ceil(performance.now() - start);
      record.exitCode = code;
      record.signal = signal;
      record.cleanup = sweep;
      requireTrue(!termination && !interrupted && !sweep.termSent && sweep.errors.length === 0 && code === 0, 'Approval runner failed, timed out, or left a process group');
      validateObservation(JSON.parse(fs.readFileSync(observationPath, 'utf8')));
      execFileSync(process.execPath, ['t/unit/test_runner_lifecycle.js', '--verify-report', processReport, '--expect-mocha-attempts', '1'], {timeout: 10000});
      const processData = JSON.parse(fs.readFileSync(processReport, 'utf8'));
      const sidecar = path.resolve('.artifacts/verify/attempts', processData.runId, '1-explicit-paths-attempt.json');
      const flake = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
      requireTrue(flake.retries.length === 0 && flake.pending.length === 0, 'Retry or skipped check in approval flow');
      json(path.join(trialDir, 'attempt.json'), flake);
      record.approvedLeave = await approvedRow(env.TEST_DB_STORAGE);
      record.checks = 22;
      record.status = 'passed';
    } catch (error) {
      record.reason = redact(error.message).slice(0, 2048);
      throw error;
    } finally {
      clearTimeout(timer);
      stopActive = null;
      filter.end();
      fs.closeSync(log);
      json(path.join(trialDir, 'result.json'), record);
      // Only this invocation's synthetic DB; it is never a user database.
      fs.rmSync(storageDir, {recursive: true, force: true});
    }
    process.stdout.write(`${kind} ${index}: ${record.durationMs} ms, 22 checks, approved DB row, no retries\n`);
    return record;
  }
  try {
    for (let index = 1; index <= 3; index++) { report.calibration.push(await trial('calibration', index)); }
    report.iterationCount = selectIterations(report.calibration.map(value => value.durationMs));
    for (let index = 1; index <= report.iterationCount; index++) { report.stress.push(await trial('stress', index)); }
    report.stressDurationMs = report.stress.reduce((total, value) => total + value.durationMs, 0);
    requireTrue(report.stressDurationMs <= BUDGET_MS, 'Measured stress exceeded its sampling budget');
    report.source.end = sourceState();
    requireTrue(JSON.stringify(report.source.start) === JSON.stringify(report.source.end), 'Source changed during measurement');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.reason = redact(error.message).slice(0, 2048);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    report.finishedAt = new Date().toISOString();
    json(path.join(directory, 'measurement.json'), report);
    process.stdout.write(`APPROVAL_MEASUREMENT ${path.join(directory, 'measurement.json')} (${report.status})\n`);
  }
}

if (require.main === module) { main().catch(error => { process.stderr.write(redact(error.message) + '\n'); process.exitCode = 1; }); }
module.exports = {selectIterations, validateObservation};
