'use strict';

const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');

// A child isolates the old helpers' unhandled rejections from Mocha itself.
async function inspect(testCase) {
  const unhandled = [];
  process.on('unhandledRejection', error => unhandled.push(error.message));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fault = () => Promise.reject(new Error('synthetic driver failure'));
  const driver = {
    get: () => testCase.mode === 'navigation-error' ? fault() : Promise.resolve(),
    findElements: selector => {
      if (testCase.mode === 'lookup-error') { return fault(); }
      const wanted = testCase.link ? 'employee-link' : 'employee-name';
      const primary = selector.value.endsWith(wanted);
      return Promise.resolve(Array.from({length: primary
        ? testCase.mode === 'wrong-count' ? 0 : 1
        : testCase.mode === 'opposite' ? 1 : 0}));
    },
    findElement: () => testCase.mode === 'lookup-error' ? fault() : Promise.resolve({
      getAttribute: () => testCase.mode === 'attribute-error' ? fault()
        : testCase.mode === 'deferred' ? gate : Promise.resolve('actual'),
      isSelected: () => testCase.mode === 'selected-error' ? fault() : Promise.resolve(testCase.selected),
    }),
  };
  const helper = require(process.cwd() + '/t/lib/' + testCase.helper);
  let state = 'pending';
  let sameDriver = false;
  const args = testCase.helper === 'check_elements' ? {
    driver, elements_to_check: testCase.mode === 'empty' ? [] : [{
      selector: '#synthetic', value: testCase.mode === 'mismatch' ? 'wrong' : testCase.tick ? testCase.selected ? 'on' : 'off' : 'actual',
      ...(testCase.tick ? {tick: true} : {}),
    }],
  } : {driver: testCase.mode === 'missing-driver' ? null : driver, emails: ['synthetic@example.test'], is_link: testCase.link};
  helper(args).then(value => { state = 'fulfilled'; sameDriver = value.driver === driver; }, () => { state = 'rejected'; });
  const drain = () => new Promise(resolve => setImmediate(() => setImmediate(resolve)));
  await drain();
  const beforeRelease = state;
  release('actual');
  await drain();
  process.stdout.write(JSON.stringify({state, beforeRelease, sameDriver, unhandled}));
}

describe('browser assertion helper promise ownership', function() {
  this.timeout(10000);

  const cases = [
    {helper: 'check_elements', mode: 'empty'},
    {helper: 'check_elements', mode: 'value'},
    {helper: 'check_elements', mode: 'deferred'},
    {helper: 'check_elements', mode: 'checked', tick: true, selected: true},
    {helper: 'check_elements', mode: 'unchecked', tick: true, selected: false},
    {helper: 'check_elements', mode: 'mismatch', rejected: true},
    {helper: 'check_elements', mode: 'lookup-error', rejected: true},
    {helper: 'check_elements', mode: 'attribute-error', rejected: true},
    {helper: 'check_elements', mode: 'selected-error', tick: true, rejected: true},
    {helper: 'teamview_check_user', mode: 'links', link: true},
    {helper: 'teamview_check_user', mode: 'names'},
    {helper: 'teamview_check_user', mode: 'wrong-count', rejected: true},
    {helper: 'teamview_check_user', mode: 'opposite', rejected: true},
    {helper: 'teamview_check_user', mode: 'navigation-error', rejected: true},
    {helper: 'teamview_check_user', mode: 'lookup-error', rejected: true},
    {helper: 'teamview_check_user', mode: 'missing-driver', rejected: true},
  ];

  for (const testCase of cases) {
    it(`${testCase.helper}: ${testCase.mode}`, function() {
      const result = spawnSync(process.execPath, ['-e', `(${inspect})(${JSON.stringify(testCase)}).catch(error => { console.error(error); process.exitCode = 1; });`], {
        encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL',
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      const outcome = JSON.parse(result.stdout);
      if (testCase.mode === 'deferred') { assert.equal(outcome.beforeRelease, 'pending'); }
      assert.equal(outcome.state, testCase.rejected ? 'rejected' : 'fulfilled', result.stdout);
      assert.deepEqual(outcome.unhandled, []);
      if (!testCase.rejected) { assert.equal(outcome.sameDriver, true); }
    });
  }
});
