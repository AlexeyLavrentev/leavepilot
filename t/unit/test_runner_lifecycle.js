'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnInGroup, terminateGroup, GROUPS_SUPPORTED } = require('../../bin/lib/spawn_group');
const expect = require('chai').expect;

const verifyReport = (reportPath, expectedMochaAttempts) => {
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  if (!report || !Array.isArray(report.processes)) {
    throw new Error('invalid test process report');
  }
  report.processes.forEach(entry => {
    if (!entry.termination) {
      throw new Error(`owned process ${entry.pid} has no termination outcome`);
    }
    try {
      process.kill(entry.pid, 0);
      throw new Error(`owned process ${entry.pid} is still alive`);
    } catch (error) {
      if (error.code && error.code !== 'ESRCH') {
        throw error;
      }
    }
  });
  if (expectedMochaAttempts !== undefined) {
    const mochaAttempts = report.processes.filter(entry => entry.label === 'mocha').length;
    if (mochaAttempts !== expectedMochaAttempts) {
      throw new Error(`expected ${expectedMochaAttempts} Mocha attempts, found ${mochaAttempts}`);
    }
  }
  return report;
};

if (require.main === module) {
  const reportIndex = process.argv.indexOf('--verify-report');
  if (reportIndex < 0 || !process.argv[reportIndex + 1]) {
    throw new Error('usage: node t/unit/test_runner_lifecycle.js --verify-report <path>');
  }
  const attemptIndex = process.argv.indexOf('--expect-mocha-attempts');
  const expectedMochaAttempts = attemptIndex < 0 ? undefined : Number(process.argv[attemptIndex + 1]);
  if (attemptIndex >= 0 && !Number.isInteger(expectedMochaAttempts)) {
    throw new Error('--expect-mocha-attempts must be an integer');
  }
  verifyReport(process.argv[reportIndex + 1], expectedMochaAttempts);
  process.exit(0);
}

describe('test runner lifecycle', function() {
  it('records only owned process identities and termination outcomes', function() {
    const source = fs.readFileSync('bin/test.js', 'utf8');

    expect(source).to.contain('registerOwnedProcess');
    expect(source).to.contain('recordTermination');
    expect(source).to.contain('terminateGroup(child)');
    expect(source).to.not.contain('pkill');
    expect(source).to.not.contain('killall');
  });

  it('uses a named finite timeout for explicit path Mocha runs', function() {
    const source = fs.readFileSync('bin/test.js', 'utf8');

    expect(source).to.contain('TEST_EXPLICIT_PATH_TIMEOUT_MS');
    expect(source).to.contain('explicit-path mocha timed out after ${explicitTimeoutMs}ms');
  });

  it('records a timed-out batch file and owned process identity before cleanup', function() {
    const source = fs.readFileSync('bin/test.js', 'utf8');

    expect(source).to.contain("diagnostic: { file: batch.join(', '), batch: index + 1, totalBatches: batches.length }");
    expect(source).to.contain("lastTest: 'unavailable'");
    expect(source).to.contain('batch=${diagnostic.file} lastTest=unavailable pid=${child.pid} pgid=${child.pid}');
  });

  it('sweeps an exited Mocha group without another grace interval', function() {
    const source = fs.readFileSync('bin/test.js', 'utf8');

    expect(source).to.contain('terminateGroup(child, {graceMs: 0})');
  });

  it('records cleanup for a hung owned fixture in an accepted report', async function() {
    if (!GROUPS_SUPPORTED) {
      return this.skip();
    }

    const child = spawnInGroup(process.execPath, ['-e', 'setInterval(() => {}, 1000000)'], {
      stdio: 'ignore',
    });
    const reportPath = path.join(os.tmpdir(), `test-runner-lifecycle-${process.pid}-${Date.now()}.json`);
    const report = {
      processes: [{
        label: 'mocha',
        pid: child.pid,
        pgid: child.pid,
        diagnostic: { file: 't/fixtures/hung_batch.js', deadlineMs: 120000, lastTest: 'unavailable' },
        termination: null,
      }],
    };

    try {
      await terminateGroup(child, { graceMs: 50 });
      report.processes[0].termination = { outcome: 'timeout', term: true, kill: true };
      fs.writeFileSync(reportPath, JSON.stringify(report));
      expect(verifyReport(reportPath, 1)).to.deep.equal(report);
    } finally {
      fs.rmSync(reportPath, {force: true});
    }
  });

  it('does not rerun an explicit path when TEST_RETRIES=0', function() {
    const source = fs.readFileSync('bin/test.js', 'utf8');
    const explicitBranch = source.slice(source.indexOf('return mochaExplicit().catch'));

    expect(explicitBranch).to.contain('configuredRetries === 0');
  });

  it('preflights browsers only for browser-driving targets', function() {
    const source = fs.readFileSync('bin/test.js', 'utf8');

    expect(source).to.contain("rawArgs.some(arg => arg.startsWith('t/integration/'))");
    expect(source).to.contain('if (browserTarget)');
    expect(source).to.not.contain("prepareBrowserEnvironment());\n\nif (!process.env.KEEP_TEST_DB");
  });
});

module.exports = { verifyReport };
