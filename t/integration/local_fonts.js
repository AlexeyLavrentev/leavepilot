'use strict';

const {expect} = require('chai');
const buildDriver = require('../lib/build_driver');
const registerNewUser = require('../lib/register_new_user');

describe('Same-origin Open Sans', function() {
  this.timeout(120000);
  let driver;
  const applicationHost = `http://${process.env.TEST_HOST || '127.0.0.1'}:${process.env.PORT || 3000}/`;

  after(async function() {
    if (driver) { await driver.quit(); }
  });

  it('renders the real add-user page and all font weights without Google Fonts access', async function() {
    driver = buildDriver();
    await driver.sendDevToolsCommand('Network.enable');
    await driver.sendDevToolsCommand('Network.setCacheDisabled', {cacheDisabled: true});
    // Fail external requests immediately: fallback fonts must not make this
    // pass. We require real FontFace loads for every shipped weight below.
    await driver.sendDevToolsCommand('Network.setBlockedURLs', {
      urls: ['*://fonts.googleapis.com/*', '*://fonts.gstatic.com/*'],
    });
    await registerNewUser({driver, application_host: applicationHost});
    await driver.get(`${applicationHost}users/add/`);
    const result = await driver.executeAsyncScript(function() {
      const done = arguments[arguments.length - 1];
      Promise.all([300, 400, 600, 700].map(async function(weight) {
        const faces = await document.fonts.load(weight + ' 16px "Open Sans"', 'Leave Отпуск');
        return {weight: weight, count: faces.length, loaded: faces.every(function(face) { return face.status === 'loaded'; })};
      })).then(function(weights) {
        done({
          weights: weights,
          formPresent: !!document.querySelector('#add_new_user_form'),
          externalFontRequests: performance.getEntriesByType('resource').filter(function(entry) {
            return /^https?:\/\/fonts\.(googleapis|gstatic)\.com\//.test(entry.name);
          }).length,
        });
      }, function() { done({error: 'font-load-failed'}); });
    });
    expect(result.error).to.equal(undefined);
    expect(result.formPresent).to.equal(true);
    expect(result.externalFontRequests).to.equal(0);
    // The sample uses both Latin and Cyrillic: require both real subset faces,
    // not merely a successful load of the Latin file plus a system fallback.
    expect(result.weights).to.deep.equal([300, 400, 600, 700].map(weight => ({weight, count: 2, loaded: true})));
  });
});
