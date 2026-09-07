'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {expect} = require('chai');
const {spawnInGroup, terminateTree} = require('../../bin/lib/spawn_group');

const root = path.resolve(__dirname, '../..');

describe('runner evidence acceptance', function() {
  this.timeout(22000);
  let directory;
  let child;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-evidence-'));
    fs.mkdirSync(path.join(directory, 'bin'));
    fs.mkdirSync(path.join(directory, 't/integration'), {recursive: true});
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'));
    fs.symlinkSync(path.join(root, 't/lib'), path.join(directory, 't/lib'));
    // Only prerequisite/app startup is stubbed. The actual runner, Mocha and
    // reporters execute against a disposable suite; no real DB/browser needed.
    fs.writeFileSync(path.join(directory, 'bin/db_update.js'), 'process.exit(0);');
    fs.writeFileSync(path.join(directory, 'bin/browser_setup.js'),
      `console.log(JSON.stringify({chromeBin: '/fixture/chrome', chromedriverBin: '/fixture/driver'}));`);
    fs.writeFileSync(path.join(directory, 'bin/wwww'),
      "process.send({type: 'test-server-ready'}); setInterval(() => {}, 1000000);");
  });

  afterEach(async () => {
    if (child) { await terminateTree(child, {graceMs: 0}); }
    child = null;
    fs.rmSync(directory, {recursive: true, force: true});
  });

  async function run(source, env = {}) {
    fs.writeFileSync(path.join(directory, 't/integration/case.js'), source);
    child = spawnInGroup(process.execPath, [path.join(root, 'bin/test.js'), '--integration-only'], {
      cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], env: {
        ...process.env, TEST_RETRIES: '0', TEST_DB_STORAGE: path.join(directory, 'test.sqlite'),
        TEST_PROCESS_REPORT_PATH: path.join(directory, 'processes.json'),
        TEST_BATCH_DIAGNOSTIC_DIR: path.join(directory, 'diagnostics'), ...env,
      },
    });
    let output = '';
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-16384); });
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-16384); });
    let timer;
    try {
      const code = await Promise.race([
        new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('runner fixture exceeded deadline')), 16000); }),
      ]);
      const diagnostics = path.join(directory, 'diagnostics');
      const reports = fs.readdirSync(diagnostics).filter(name => name.endsWith('.json'))
        .map(name => JSON.parse(fs.readFileSync(path.join(diagnostics, name))))
        .filter(value => value.outcome);
      const processes = JSON.parse(fs.readFileSync(path.join(directory, 'processes.json'))).processes;
      for (const entry of processes) {
        expect(entry.termination, `missing cleanup for ${entry.label}`).not.to.equal(null);
        expect(() => process.kill(entry.pid, 0), `owned ${entry.label} survived`).to.throw().with.property('code', 'ESRCH');
      }
      return {code, output, reports};
    } finally { clearTimeout(timer); }
  }

  const passing = "it('passes', () => {});";

  it('accepts complete evidence and preserves exit code zero', async () => {
    const result = await run(passing);
    expect(result.code, result.output).to.equal(0);
    expect(result.reports).to.have.lengthOf(1);
    expect(result.reports[0]).to.include({outcome: 'pass', exitCode: 0});
    expect(result.reports[0].reporterSnapshot.event).to.equal('end');
  });

  it('rejects a stale pass snapshot when the final write fails', async () => {
    const result = await run(passing + `
      after(() => {
        const fs = require('fs'); const rename = fs.renameSync;
        fs.renameSync = (from, to) => {
          if (to === process.env.TEST_BATCH_DIAGNOSTIC_PATH) { throw new Error('injected final snapshot failure'); }
          return rename(from, to);
        };
      });`);
    expect(result.output).to.include('injected final snapshot failure');
    expect(result.code, result.output).to.equal(1);
  });

  it('rejects a sidecar with missing retry and pending collections', async () => {
    const result = await run(passing + `
      process.on('exit', () => require('fs').writeFileSync(process.env.FLAKE_ARTIFACT_PATH, '{}'));`);
    expect(result.code, result.output).to.equal(1);
  });

  for (const [name, payload] of [
    ['non-array collections', {retries: {}, pending: []}],
    ['unidentified skipped tests', {retries: [], pending: [{spec: null, title: 'skip'}]}],
    ['invalid retry attempts', {retries: [{spec: 'case.js', title: 'retry', attempt: 0, error: null}], pending: []}],
  ]) {
    it(`rejects ${name}`, async () => {
      const result = await run(passing + `
        process.on('exit', () => require('fs').writeFileSync(process.env.FLAKE_ARTIFACT_PATH, ${JSON.stringify(JSON.stringify(payload))}));`);
      expect(result.code, result.output).to.equal(1);
      expect(result.output).to.include('Required immutable flake sidecar invalid');
    });
  }

  it('retains both batch diagnostics when a diagnostic rerun passes', async () => {
    const result = await run(`
      const fs = require('fs');
      before(() => {
        if (!fs.existsSync('first-attempt')) { fs.writeFileSync('first-attempt', 'failed'); throw new Error('first batch failure'); }
      });
      ${passing}`, {TEST_RETRIES: '1'});
    expect(result.code, result.output).to.equal(1);
    expect(result.reports).to.have.lengthOf(2);
    expect(result.reports.map(report => report.outcome).sort()).to.deep.equal(['nonzero-exit', 'pass']);
    expect(new Set(result.reports.map(report => report.identity.batchId)).size).to.equal(2);
    expect(result.reports.find(report => report.outcome === 'nonzero-exit').reporterSnapshot.failure.message)
      .to.equal('first batch failure');
  });

  it('retains the last snapshot for a timed-out test without claiming completion', async () => {
    const result = await run("it('hangs', function() { this.timeout(0); setInterval(() => {}, 1000000); return new Promise(() => {}); });",
      {TEST_BATCH_TIMEOUT_MS: '500'});
    expect(result.code, result.output).to.equal(1);
    expect(result.reports[0].outcome).to.equal('timeout');
    expect(result.reports[0].reporterSnapshot.event).to.equal('test-start');
  });
});
