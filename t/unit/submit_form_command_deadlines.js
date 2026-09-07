'use strict';

const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');

async function inspect(testCase) {
  process.env.TEST_COMMAND_DEADLINE_MS = '25';
  const submit = require(process.cwd() + '/t/lib/submit_form');
  const calls = [];
  const command = (name, result) => {
    calls.push(name);
    return name === testCase.target ? new Promise(() => {}) : Promise.resolve(result);
  };
  const field = {
    isDisplayed: () => command('visibility', true),
    isSelected: () => command('selection', false),
    getAttribute: name => command(name === 'data-provide' ? 'datepicker-attribute' : 'value', name === 'data-provide' ? testCase.kind === 'datepicker' ? 'datepicker' : null : 'value'),
    clear: () => command('clear'),
    sendKeys: value => command(value === '\uE004' ? 'tab' : testCase.kind === 'file' ? 'file' : 'keys'),
    findElement: () => command('option-lookup', {getAttribute: () => command('option-value', 'value')}),
  };
  if (testCase.kind === 'fallback') { delete field.clear; delete field.sendKeys; }
  const driver = {
    findElements: () => command('lookup', [field]),
    findElement: () => command(testCase.kind === 'dropdown' ? 'dropdown-lookup' : 'lookup-one', field),
    executeScript: script => {
      if (script.includes('window.confirm')) { return command('confirmation'); }
      if (script.includes('alert.parentNode.removeChild')) { return command('clear-alerts'); }
      if (script.includes('arguments[0].click()')) { return command('click'); }
      if (script.includes('closest("#book_leave_modal")')) { return command('datepicker-scope', true); }
      if (script.includes('datepicker("setDate"')) { return command('datepicker-set', {value: 'value', valid: true}); }
      if (script.includes('return arguments[0].step =')) { return command('numeric-step'); }
      if (script.includes('arguments[0].focus()')) { return command('set-value'); }
      if (script.includes('arguments[0].value = arguments[1]')) { return command('select-option'); }
      throw new Error('Unexpected browser script');
    },
  };
  const params = {selector: '#field', value: 'value'};
  if (testCase.kind === 'checkbox') { Object.assign(params, {tick: true, value: 'on'}); }
  if (testCase.kind === 'option') { Object.assign(params, {option_selector: 'option'}); delete params.value; }
  if (testCase.kind === 'option-value') { params.option_selector = 'option'; }
  if (testCase.kind === 'dropdown') { params.dropdown_option = '#option'; }
  if (testCase.kind === 'file') { params.file = true; }
  if (testCase.kind === 'numeric') { params.change_step = true; }
  const reading = testCase.kind === 'read-value' || testCase.kind === 'read-selection';
  const result = submit({
    driver, expect_navigation: false, should_be_successful: true,
    confirm_dialog: testCase.kind === 'confirmation',
    form_params: reading || testCase.kind === 'submit' || testCase.kind === 'confirmation' ? [] : [params],
    elements_to_check: reading ? [{selector: '#field', value: 'value', ...(testCase.kind === 'read-selection' ? {tick: true} : {})}] : [],
  }).then(() => ({passed: true}), error => ({deadline: error.commandDeadlineExceeded === true, message: error.message}));
  let timer;
  try {
    const outcome = await Promise.race([result, new Promise(resolve => { timer = setTimeout(() => resolve({guardExpired: true}), 300); })]);
    process.stdout.write(JSON.stringify({...outcome, calls}));
  } finally { clearTimeout(timer); }
}

describe('submit form command deadlines', function() {
  this.timeout(10000);
  const cases = [
    ['text', 'visibility'], ['text', 'datepicker-attribute'], ['text', 'clear'], ['text', 'keys'], ['text', 'tab'],
    ['numeric', 'numeric-step'], ['fallback', 'set-value'], ['file', 'file'],
    ['checkbox', 'selection'], ['checkbox', 'click'],
    ['option', 'option-lookup'], ['option', 'option-value'], ['option-value', 'select-option'],
    ['dropdown', 'dropdown-lookup'], ['datepicker', 'datepicker-scope'], ['datepicker', 'datepicker-set'],
    ['submit', 'clear-alerts'], ['submit', 'click'], ['confirmation', 'confirmation'],
    ['read-value', 'value'], ['read-selection', 'selection'],
  ];
  for (const [kind, target] of cases) {
    it(`rejects a wedged ${target} command on the ${kind} path`, function() {
      const result = spawnSync(process.execPath, ['-e', `(${inspect})(${JSON.stringify({kind, target})}).catch(error => { console.error(error); process.exitCode = 1; });`], {
        encoding: 'utf8', timeout: 3000, killSignal: 'SIGKILL',
        env: {...process.env, TEST_TRACE_FORMS: '0', TEST_SUBMIT_DIAGNOSTIC_PATH: '', TEST_SUBMIT_DIAGNOSTIC_RUN_ID: '', TEST_SUBMIT_DIAGNOSTIC_BATCH_ID: '', TEST_SUBMIT_DIAGNOSTIC_SPEC: ''},
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      const outcome = JSON.parse(result.stdout);
      assert.ok(outcome.calls.includes(target), result.stdout);
      assert.equal(outcome.deadline, true, result.stdout);
      assert.equal(outcome.calls.at(-1), target, 'a deadline must not start fallback browser commands');
      assert.match(outcome.message, /WebDriver command did not return/);
    });
  }
});
