'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const userInfo = require('../lib/user_info');

function browser({response = [{id: 7}], httpError = null} = {}) {
  const state = {window: {}, emails: []};
  const context = {window: state.window, $: {ajax: options => {
    state.emails.push(options.data.email);
    if (httpError) { if (options.error) { options.error({status: httpError}, 'error'); } }
    else { options.success(response); }
  }}};
  state.driver = {
    executeScript: async script => vm.runInNewContext(script, context),
    executeAsyncScript: (script, ...args) => new Promise((resolve, reject) => {
      let completed = false;
      const callback = value => { completed = true; resolve(value); };
      vm.runInNewContext(`(${script}).apply(null, args)`, {...context, args: [...args, callback]});
      if (!completed) { reject(new Error('browser script callback was not completed')); }
    }),
  };
  return state;
}

describe('browser user setup helpers', function() {
  it('returns the first user and preserves an empty search result', async function() {
    for (const response of [[{id: 7}, {id: 8}], []]) {
      const {driver} = browser({response});
      const result = await userInfo({driver, email: 'employee@example.test'});
      assert.equal(result.driver, driver);
      assert.deepEqual(result.user, response[0] || {});
    }
  });

  it('transports email as data without executing it or keeping page globals', async function() {
    const state = browser();
    const email = '";window.injected=true;//@example.test';
    await userInfo({driver: state.driver, email});
    assert.deepEqual(state.emails, [email]);
    assert.deepEqual(state.window, {});
  });

  it('completes failed HTTP search with a useful error, not a script timeout', async function() {
    const {driver} = browser({httpError: 403});
    await assert.rejects(userInfo({driver, email: 'employee@example.test'}), /User search failed \(HTTP 403\)/);
  });

  it('rejects malformed search responses', async function() {
    const {driver} = browser({response: {length: 1}});
    await assert.rejects(userInfo({driver, email: 'employee@example.test'}), /Invalid user search response/);
  });

  it('keeps input errors and the original browser failure', async function() {
    await assert.rejects(userInfo({email: 'employee@example.test'}), /'driver' was not passed/);
    await assert.rejects(userInfo({driver: {}}), /'email' was not passed/);
    const failure = new Error('browser unavailable');
    const driver = {executeScript: async () => { throw failure; }, executeAsyncScript: async () => { throw failure; }};
    await assert.rejects(userInfo({driver, email: 'employee@example.test'}), error => error === failure);
  });

  for (const useId of [false, true]) {
    it(`sets the start date in order using ${useId ? 'an existing ID' : 'email lookup'}`, async function() {
      const filename = path.resolve('t/lib/set_user_to_start_at_the_beginning_of_the_year.js');
      const localRequire = createRequire(filename);
      const calls = [];
      const module = {exports: {}};
      const driver = {};
      const failure = new Error('setup operation failed');
      let failAt;
      const helpers = {
        './user_info': async args => { calls.push(['lookup', args]); if (failAt === 'lookup') { throw failure; } return {user: {id: 7}}; },
        './open_page': async args => { calls.push(['open', args]); if (failAt === 'open') { throw failure; } },
        './submit_form': async args => { calls.push(['submit', args]); if (failAt === 'submit') { throw failure; } },
        './config': {get_application_host: () => 'http://example.test/'},
      };
      vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {module, require: name => helpers[name] || localRequire(name)}, {filename});
      const args = {driver, email: 'employee@example.test', year: 2018, ...(useId ? {userId: 7} : {})};
      const result = await module.exports(args);
      assert.equal(result.driver, driver);
      assert.deepEqual(calls.map(([name]) => name), useId ? ['open', 'submit', 'open'] : ['lookup', 'open', 'submit', 'open']);
      assert.equal(calls.find(([name]) => name === 'open')[1].url, 'http://example.test/users/edit/7/');
      assert.equal(calls.find(([name]) => name === 'submit')[1].form_params[0].value, '2018-01-01');
      assert.equal(calls.at(-1)[1].url, 'http://example.test/');
      calls.length = 0;
      await module.exports({...args, overwriteDate: localRequire('../../lib/util/date').utc('2017-03-04'), applicationHost: 'http://custom.test/'});
      assert.equal(calls.find(([name]) => name === 'submit')[1].form_params[0].value, '2017-03-04');
      assert.equal(calls.at(-1)[1].url, 'http://custom.test/');
      for (failAt of useId ? ['open', 'submit'] : ['lookup', 'open', 'submit']) {
        calls.length = 0;
        await assert.rejects(module.exports(args), error => error === failure);
        assert.equal(calls.at(-1)[0], failAt, 'no later setup operation after failure');
      }
    });
  }
});
