'use strict';

const fs = require('fs');
const path = require('path');
const FlakeReporter = require('./flake_reporter');

module.exports = class ApprovalStressReporter extends FlakeReporter {
  constructor(runner, options) {
    super(runner, options);
    let approvalActionPassed = false;
    let employeeCalendarCheckPassed = false;
    let retries = 0;
    runner.on('retry', () => { retries++; });
    runner.on('pass', test => {
      if (path.resolve(test.file) !== path.resolve('t/integration/leave_request/basic_leave_request.js')) { return; }
      if (test.title === 'Approve newly added leave request') { approvalActionPassed = true; }
      if (approvalActionPassed && test.title === 'Check that all days are marked as pended') { employeeCalendarCheckPassed = true; }
    });
    runner.once('end', () => {
      const target = path.resolve(process.env.APPROVAL_STRESS_REPORT_PATH || '');
      if (!target.startsWith(path.resolve('.artifacts/verify') + path.sep)) {
        throw new Error('Approval observation path must be inside verification artifacts');
      }
      const {tests, passes, failures, pending} = runner.stats;
      fs.writeFileSync(target, JSON.stringify({tests, passes, failures, pending, retries, approvalActionPassed, employeeCalendarCheckPassed}) + '\n', {flag: 'wx', mode: 0o600});
    });
  }
};
