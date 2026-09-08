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
  const selectors = [];
  const css = testCase.css || 'actual';
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
    findElement: selector => {
      selectors.push(selector.value);
      return testCase.mode === 'lookup-error' ? fault() : Promise.resolve({
      getAttribute: () => testCase.mode === 'attribute-error' ? fault()
        : testCase.mode === 'deferred' ? gate : Promise.resolve(css),
      isSelected: () => testCase.mode === 'selected-error' ? fault() : Promise.resolve(testCase.selected),
      });
    },
  };
  const helper = require(process.cwd() + '/t/lib/' + testCase.helper);
  let state = 'pending';
  let rejectionMessage;
  let sameDriver = false;
  const dayjs = require(process.cwd() + '/lib/util/date');
  const args = testCase.helper === 'check_booking_on_calendar' ? {
    driver: testCase.mode === 'missing-driver' ? null : driver,
    type: testCase.type,
    full_days: testCase.mode === 'empty' ? [] : [dayjs.utc('2015-06-16')],
    halfs_1st_days: testCase.mode === 'empty' ? [] : [dayjs.utc('2015-06-15')],
    halfs_2nd_days: testCase.mode === 'empty' ? [] : [dayjs.utc('2015-06-17')],
  } : testCase.helper === 'check_elements' ? {
    driver, elements_to_check: testCase.mode === 'empty' ? [] : [{
      selector: '#synthetic', value: testCase.mode === 'mismatch' ? 'wrong' : testCase.tick ? testCase.selected ? 'on' : 'off' : 'actual',
      ...(testCase.tick ? {tick: true} : {}),
    }],
  } : {driver: testCase.mode === 'missing-driver' ? null : driver, emails: ['synthetic@example.test'], is_link: testCase.link};
  helper(args).then(value => { state = 'fulfilled'; sameDriver = value.driver === driver; }, error => { state = 'rejected'; rejectionMessage = error.message; });
  const drain = () => new Promise(resolve => setImmediate(() => setImmediate(resolve)));
  await drain();
  const beforeRelease = state;
  release(css);
  await drain();
  process.stdout.write(JSON.stringify({state, beforeRelease, sameDriver, unhandled, selectors, rejectionMessage}));
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
    ...[
      {mode: 'empty', type: 'pended'},
      {mode: 'pending', type: 'pended', css: 'day_16 leave_cell_pended half_1st'},
      {mode: 'approved', type: 'approved', css: 'day_16 leave_cell half_1st'},
      {mode: 'deferred', type: 'approved', css: 'leave_cell'},
      {mode: 'mismatch', type: 'approved', css: 'leave_cell_pended', rejected: true},
      {mode: 'lookup-error', type: 'approved', rejected: true},
      {mode: 'attribute-error', type: 'approved', rejected: true},
      {mode: 'missing-driver', type: 'approved', rejected: true},
      {mode: 'invalid-type', type: 'unknown', rejected: true},
      {mode: 'absent', type: 'absent', css: 'day_16 half_1st'},
      {mode: 'still-pending', type: 'absent', css: 'leave_cell_pended', rejected: true},
      {mode: 'still-approved', type: 'absent', css: 'leave_cell', rejected: true},
    ].map(testCase => ({helper: 'check_booking_on_calendar', ...testCase})),
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
      if (testCase.mode === 'still-pending' || testCase.mode === 'still-approved') {
        assert.match(outcome.rejectionMessage, /not to match/);
      }
      if (!testCase.rejected) { assert.equal(outcome.sameDriver, true); }
      if (testCase.helper === 'check_booking_on_calendar' && !testCase.rejected) {
        assert.deepEqual(outcome.selectors, testCase.mode === 'empty' ? [] : [
          'table.month_June td.day_16.half_1st', 'table.month_June td.day_16.half_2nd',
          'table.month_June td.day_15.half_1st', 'table.month_June td.day_17.half_2nd',
        ]);
      }
    });
  }
});
