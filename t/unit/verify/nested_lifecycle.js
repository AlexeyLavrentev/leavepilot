'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const {expect} = require('chai');
const {spawnInGroup, killGroup, GROUPS_SUPPORTED} = require('../../../bin/lib/spawn_group');

const waitFor = async (predicate, timeoutMs) => {
  const until = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return Boolean(predicate());
};
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code !== 'ESRCH') { throw error; } return false; }
};

describe('verifier nested runner lifecycle', function() {
  this.timeout(30000);

  for (const signal of [null, 'SIGTERM', 'SIGINT']) {
    it(`cleans nested test runner groups on ${signal || 'deadline'} and persists the outcome`, async function() {
      if (!GROUPS_SUPPORTED) { return this.skip(); }
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-nested-'));
      const reportPath = path.join(directory, 'processes.json');
      const pointer = path.join(directory, 'run.path');
      const oldFlakeReport = fs.existsSync('flake-report.json') ? fs.readFileSync('flake-report.json') : null;
      const socket = net.createServer();
      await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
      const port = socket.address().port;
      await new Promise(resolve => socket.close(resolve));
      let output = '';
      let exit;
      let spawnError;
      const unrelated = spawnInGroup(process.execPath, ['-e', 'setInterval(() => {}, 1000000)'], {stdio: 'ignore'});
      const child = spawnInGroup(process.execPath, [
        'bin/verify.js', '--stage', 'test-nested-timeout', '--run-path-file', pointer,
      ], {stdio: ['ignore', 'pipe', 'pipe'], env: {
        ...process.env, PORT: String(port), TEST_DB_DIALECT: 'sqlite',
        TEST_DB_STORAGE: path.join(directory, 'test.sqlite'), TEST_PROCESS_REPORT_PATH: reportPath,
        TEST_RETRIES: '0', TEST_EXPLICIT_PATH_TIMEOUT_MS: '60000', DB_LOGGING: 'false',
      }});
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      child.once('exit', (code, receivedSignal) => { exit = {code, signal: receivedSignal}; });
      child.once('error', error => { spawnError = error; });
      let descendantPid;
      try {
        expect(await waitFor(() => /nested-ready=(\d+)/.test(output) || exit || spawnError, 12000), output.slice(-2000)).to.equal(true);
        expect(spawnError).to.equal(undefined);
        const match = output.match(/nested-ready=(\d+)/);
        expect(match, output.slice(-2000)).not.to.equal(null);
        descendantPid = Number(match[1]);
        if (signal) { child.kill(signal); }
        expect(await waitFor(() => exit, 18000), 'verifier failed to exit').to.equal(true);
        expect(await waitFor(() => !alive(descendantPid), 2000), `detached descendant survived verifier exit ${JSON.stringify(exit)}; ${output.slice(-2000)}`).to.equal(true);
        expect(exit.code).to.equal(signal === 'SIGINT' ? 130 : signal ? 143 : 1);
        const runRoot = fs.readFileSync(pointer, 'utf8').trim();
        const summary = JSON.parse(fs.readFileSync(path.join(runRoot, 'summary.json')));
        const stage = summary.stages[0];
        expect(summary.aggregate).to.equal('failed');
        expect(stage.failureClass).to.equal(signal ? 'runner error' : 'timeout');
        expect(stage.termination.snapshotError).to.equal(null);
        // Concurrent inner/outer cleanup can report a failed signal after the
        // other owner killed the group. Keep that error in evidence; prove the
        // actual postcondition for EVERY recorded PID, not just signal flags.
        for (const entry of stage.termination.processes) {
          expect(await waitFor(() => !alive(entry.pid), 2000), `tree process ${entry.pid} survived`).to.equal(true);
        }
        expect(stage.termination.processes.some(entry => entry.pid === descendantPid)).to.equal(true);
        expect(stage.termination.groups.some(entry => entry.pid === descendantPid && entry.killSent)).to.equal(true);
        expect(JSON.parse(fs.readFileSync(stage.attempts[0].evidence))).to.deep.equal(stage);
        expect(alive(unrelated.pid), 'an unrelated Node process was terminated').to.equal(true);
        const report = JSON.parse(fs.readFileSync(reportPath));
        for (const entry of report.processes) {
          expect(await waitFor(() => !alive(entry.pid), 2000), `owned process ${entry.pid} survived`).to.equal(true);
        }
      } finally {
        // The negative pre-fix run must not leave its deliberately leaked tree.
        if (fs.existsSync(reportPath)) {
          for (const entry of JSON.parse(fs.readFileSync(reportPath)).processes) {
            killGroup({pid: entry.pid}, 'SIGKILL');
          }
        }
        if (descendantPid) { killGroup({pid: descendantPid}, 'SIGKILL'); }
        killGroup(child, 'SIGKILL');
        killGroup(unrelated, 'SIGKILL');
        await waitFor(() => exit, 2000);
        if (oldFlakeReport) { fs.writeFileSync('flake-report.json', oldFlakeReport); }
        else { fs.rmSync('flake-report.json', {force: true}); }
        fs.rmSync(directory, {recursive: true, force: true});
      }
    });
  }
});
