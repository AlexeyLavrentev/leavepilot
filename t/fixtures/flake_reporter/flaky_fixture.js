'use strict';

/*
  Fixture driven only by t/unit/flake_reporter.js inside a child mocha with
  --retries 1: the first attempt of the test fails, the retry passes. A
  module-level counter survives the in-process retry, which is exactly the
  shape of flake the reporter must record. Not named *_spec / not under
  t/unit on purpose: the suite must not collect it.
*/

var attempts = 0;

describe('flake reporter fixture: fail once, pass on retry', function() {
  it('fails its first attempt and passes the second', function() {
    attempts += 1;
    if (attempts < 2) {
      throw new Error('deliberate first-attempt failure for the flake reporter fixture');
    }
  });
});
