'use strict';

describe('reproduction fixture', function() {
  if (process.env.TEST_REPRO_MODE === 'early-exit') {
    it('exits zero without a completed test', () => process.exit(0));
  } else if (process.env.TEST_REPRO_MODE === 'retry') {
    let calls = 0;
    it('passes only after retry', function() {
      this.retries(1);
      if (calls++ === 0) { throw new Error('controlled first failure'); }
    });
  } else if (process.env.TEST_REPRO_MODE === 'hang') {
    it('hangs without a Mocha timeout', function(done) {
      this.timeout(0);
      setInterval(() => {}, 1000000);
    });
  } else {
    it('fails before a later pass', () => { throw new Error('password=private-repro-value'); });
    it('passes afterwards', () => {});
  }
});
