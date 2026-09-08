'use strict';

const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');

// Evaluate the actual scenario callbacks; isolate unhandled rejections from Mocha.
async function inspect(filename, missingDriver) {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const {createRequire} = require('node:module');
  const localRequire = createRequire(filename);
  const suites = [];
  let current;
  let failing = false;
  const failure = new Error('synthetic browser/helper failure');
  const unhandled = [];
  process.on('unhandledRejection', error => unhandled.push(error.message));
  const driver = new Proxy({}, {get: () => () => Promise.reject(failure)});
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: name => {
      if (name === '../../lib/config') {
        return {get_application_host: () => 'http://example.test/', get_execution_timeout: () => 1000};
      }
      if (name.startsWith('../../lib/')) {
        const helper = () => failing ? Promise.reject(failure)
          : Promise.resolve({driver, email: 'synthetic@example.test', new_user_email: 'employee@example.test'});
        helper._waitForModalClosed = helper;
        return helper;
      }
      return localRequire(name);
    },
    describe: (title, fn) => {
      current = {title, tests: [], hooks: []};
      suites.push(current);
      fn.call({timeout() {}});
    },
    it: (title, fn) => current.tests.push({title, fn}),
    after: fn => current.hooks.push({title: 'after', fn}),
  }, {filename});

  const drain = () => new Promise(resolve => setImmediate(() => setImmediate(resolve)));
  async function invoke(fn) {
    const calls = [];
    const done = error => calls.push(error ? error === failure ? 'original-error' : String(error) : 'success');
    try {
      const result = fn.length ? fn(done) : fn();
      if (result && typeof result.then === 'function') { result.then(() => done(), done); }
      else if (!fn.length) { done(); }
    } catch (error) { done(error); }
    await drain();
    return calls;
  }
  const outcomes = [];
  for (const suite of suites) {
    if (!missingDriver) {
      failing = false;
      const setup = await invoke(suite.tests.find(test => test.fn.length > 0).fn);
      if (JSON.stringify(setup) !== '["success"]') { throw new Error('Invalid fixture setup'); }
    }
    failing = true;
    for (const test of missingDriver ? suite.hooks : [...suite.tests, ...suite.hooks]) {
      outcomes.push({title: `${suite.title}: ${test.title}`, precondition: test.title === 'Check precondition', calls: await invoke(test.fn)});
    }
  }
  process.stdout.write(JSON.stringify({outcomes, unhandled}));
}

describe('leave creation scenario error ownership', function() {
  this.timeout(10000);
  for (const name of ['basic_leave_request', 'create_leave_with_single_user', 'leave_in_next_year', 'try_to_overbook_allowance',
    'cancel_basic', 'leave_request_revoke', 'leave_request_revoke_by_admin',
    'ovelapping_bookings', 'ovelapping_bookings_halfs', 'rendering_of_halves']) {
    for (const missingDriver of [false, true]) {
      it(`${name}: ${missingDriver ? 'cleanup before browser acquisition' : 'every step and teardown forwards the original failure once'}`, function() {
        const filename = require('node:path').resolve('t/integration/leave_request', name + '.js');
        const result = spawnSync(process.execPath, ['-e', `(${inspect})(${JSON.stringify(filename)}, ${missingDriver}).catch(error => { console.error(error); process.exitCode = 1; });`], {
          encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL',
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        const {outcomes, unhandled} = JSON.parse(result.stdout);
        assert.ok(outcomes.length > 0);
        const expected = missingDriver ? 'success' : 'original-error';
        const failures = outcomes.filter(outcome => JSON.stringify(outcome.calls) !== JSON.stringify([outcome.precondition ? 'success' : expected]));
        assert.deepEqual(failures, [], JSON.stringify({failures, unhandled}, null, 2));
        assert.deepEqual(unhandled, []);
      });
    }
  }
});
