'use strict';

const buildDriver = require('../../lib/build_driver');

describe('controlled browser capture', function() {
  this.timeout(10000);
  let driver;
  before(async () => {
    driver = buildDriver();
    await driver.executeScript(() => {
      document.body.innerHTML = '<form><input value="private-capture-value"><button>private-capture-value</button></form>';
      console.error('TypeError private-capture-value');
    });
  });
  after(async () => { if (driver) { await driver.quit(); } });
  it('retains the controlled failing browser context', function(done) {
    if (['hang', 'unresponsive'].includes(process.env.TEST_CAPTURE_MODE)) {
      this.timeout(0);
      if (process.env.TEST_CAPTURE_MODE === 'unresponsive') {
        // Hold a browser command open; the verifier must still reap this tree.
        driver.executeAsyncScript(() => {}).catch(() => {});
      }
      return;
    }
    done(new Error('controlled browser failure'));
  });
});
