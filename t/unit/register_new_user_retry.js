'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {createRequire} = require('module');
const {expect} = require('chai');

const filename = path.resolve('t/lib/register_new_user.js');
const localRequire = createRequire(filename);

async function failRegistration({retries, callerOwned = false, quitFails = false}) {
  const failure = new Error('invalid session id: synthetic registration failure');
  let builds = 0;
  let quits = 0;
  const driver = {
    getTitle: () => Promise.reject(failure),
    quit: () => { quits++; return quitFails ? Promise.reject(new Error('quit failure')) : Promise.resolve(); },
  };
  const context = {module: {exports: {}}, process: {env: {TEST_RETRIES: retries}}};
  context.require = name => {
    if (name === './build_driver') { return () => { builds++; return driver; }; }
    if (name === './set_viewport') { return () => Promise.reject(failure); }
    return localRequire(name);
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, {filename});
  let error;
  try { await context.module.exports({application_host: 'http://127.0.0.1:1/', ...(callerOwned ? {driver} : {})}); } catch (caught) { error = caught; }
  return {error, failure, builds, quits};
}

describe('registration helper first-attempt policy', () => {
  it('does not restart a failed browser when retries are disabled', async () => {
    const result = await failRegistration({retries: '0'});
    expect(result.error).to.equal(result.failure);
    expect(result.builds).to.equal(1);
    expect(result.quits).to.equal(1);
  });

  it('retains one default diagnostic retry and cleans up both owned drivers', async () => {
    const result = await failRegistration({});
    expect(result.error).to.equal(result.failure);
    expect(result.builds).to.equal(2);
    expect(result.quits).to.equal(2);
  });

  it('does not close a caller-owned driver', async () => {
    const result = await failRegistration({retries: '0', callerOwned: true});
    expect(result.error).to.equal(result.failure);
    expect(result.builds).to.equal(0);
    expect(result.quits).to.equal(0);
  });

  it('preserves the original failure when owned-driver cleanup fails', async () => {
    const result = await failRegistration({retries: '0', quitFails: true});
    expect(result.error).to.equal(result.failure);
    expect(result.builds).to.equal(1);
    expect(result.quits).to.equal(1);
  });
});
