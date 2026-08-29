'use strict';

const fs = require('fs');
const expect = require('chai').expect;

const verifyReport = reportPath => {
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
  return report;
};

if (require.main === module) {
  const reportIndex = process.argv.indexOf('--verify-report');
  if (reportIndex < 0 || !process.argv[reportIndex + 1]) {
    throw new Error('usage: node t/unit/test_runner_lifecycle.js --verify-report <path>');
  }
  verifyReport(process.argv[reportIndex + 1]);
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

  it('does not rerun an explicit path when TEST_RETRIES=0', function() {
    const source = fs.readFileSync('bin/test.js', 'utf8');
    const explicitBranch = source.slice(source.indexOf('return mochaExplicit().catch'));

    expect(explicitBranch).to.contain('configuredRetries === 0');
  });
});

module.exports = { verifyReport };
