'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {EventEmitter} = require('events');
const {expect} = require('chai');

describe('approval stress observation reporter', () => {
  let directory;
  let target;
  let runner;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.resolve('.artifacts/verify/approval-reporter-test-'));
    target = path.join(directory, 'observation.json');
    runner = new EventEmitter();
    runner.stats = {tests: 22, passes: 22, failures: 0, pending: 0};
    const context = {module: {exports: {}}, process: {env: {APPROVAL_STRESS_REPORT_PATH: target}}, require: name => name === './flake_reporter' ? class {} : require(name)};
    vm.runInNewContext(fs.readFileSync('t/lib/approval_stress_reporter.js', 'utf8'), context);
    const _reporter = new context.module.exports(runner, {});
  });
  afterEach(() => fs.rmSync(directory, {recursive: true, force: true}));
  const pass = title => ({title, file: 't/integration/leave_request/basic_leave_request.js'});

  it('records actual pass/retry events separately from console output', () => {
    runner.emit('pass', pass('Approve newly added leave request'));
    runner.emit('pass', pass('Check that all days are marked as pended'));
    runner.emit('retry');
    runner.emit('end');
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).to.deep.equal({...runner.stats, retries: 1, approvalActionPassed: true, employeeCalendarCheckPassed: true});
  });

  it('does not count calendar checks before approval or a pass from another file', () => {
    runner.emit('pass', pass('Check that all days are marked as pended'));
    runner.emit('pass', {...pass('Approve newly added leave request'), file: 'other.js'});
    runner.emit('end');
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).to.include({approvalActionPassed: false, employeeCalendarCheckPassed: false});
  });

  it('does not overwrite prior observations', () => {
    fs.writeFileSync(target, 'prior observation');
    expect(() => runner.emit('end')).to.throw();
    expect(fs.readFileSync(target, 'utf8')).to.equal('prior observation');
  });
});
