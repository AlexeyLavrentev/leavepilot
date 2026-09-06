'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const {expect} = require('chai');
const {spawnInGroup, terminateGroup} = require('../../../bin/lib/spawn_group');

describe('test runner first-pass outcome', function() {
  this.timeout(40000);

  it('keeps a successful in-process Mocha retry red and retains its sidecar', async function() {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'leavepilot-retry-'));
    const reportPath = path.resolve('flake-report.json');
    const previousReport = fs.existsSync(reportPath) ? fs.readFileSync(reportPath) : null;
    let child;
    let timer;
    let output = '';
    const attempts = path.resolve('.artifacts/verify/attempts');
    const previousAttempts = new Set(fs.existsSync(attempts) ? fs.readdirSync(attempts) : []);
    try {
      child = spawnInGroup(process.execPath, ['bin/test.js', 't/fixtures/flake_reporter/flaky_fixture.js'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {...process.env, PORT: String(port), TEST_DB_STORAGE: path.join(directory, 'test.sqlite'), TEST_DB_DIALECT: 'sqlite', DB_LOGGING: 'false', TEST_RETRIES: '1', TEST_CANONICAL_VERIFY: 'true'},
      });
      child.stdout.on('data', chunk => { output = (output + chunk).slice(-16384); });
      child.stderr.on('data', chunk => { output = (output + chunk).slice(-16384); });
      const result = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
        timer = setTimeout(() => { terminateGroup(child).catch(reject); }, 30000);
      });
      expect(result, output).to.equal(1);
      expect(output).to.include('1 passing');
      expect(output).to.include('diagnostic retries cannot make this run green');
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      expect(report).to.have.lengthOf(1);
      expect(report[0]).to.include({layer: 'mocha', attempt: 1});
      const owned = fs.readdirSync(attempts).filter(name => name.startsWith(`${child.pid}-`) && !previousAttempts.has(name));
      expect(owned).to.have.lengthOf(1);
      const sidecars = fs.readdirSync(path.join(attempts, owned[0]));
      expect(sidecars).to.have.lengthOf(1);
      const sidecar = JSON.parse(fs.readFileSync(path.join(attempts, owned[0], sidecars[0]), 'utf8'));
      expect(sidecar.retries).to.have.lengthOf(1);
    } finally {
      clearTimeout(timer);
      if (child) { await terminateGroup(child, {graceMs: 0}); }
      fs.rmSync(directory, {recursive: true, force: true});
      if (previousReport) { fs.writeFileSync(reportPath, previousReport); }
      else { fs.rmSync(reportPath, {force: true}); }
    }
  });
});
