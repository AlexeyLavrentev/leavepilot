'use strict';

// Explicit local/CI probe; not part of browser-independent unit discovery.
const {strict: assert} = require('assert');
const buildDriver = require('../../lib/build_driver');

describe('browser diagnostic identity probe', function() {
  this.timeout(30000);
  let driver;
  after(async () => { if (driver) { await driver.quit(); } });
  it('obtains actual session capabilities without application login', async () => {
    driver = buildDriver();
    const capabilities = await driver.getCapabilities();
    assert.match(capabilities.get('browserVersion'), /^\d+\.\d+\.\d+\.\d+$/);
    assert.match(capabilities.get('chrome').chromedriverVersion, /^\d+\.\d+\.\d+\.\d+/);
  });
});
