'use strict';

/*
  Fixture driven only by t/unit/flake_reporter.js inside a child mocha: one
  honest self-skip, recorded by the reporter as a pending event. Not under
  t/unit on purpose: the suite must not collect it (a collected self-skip
  would also feed the skip-honesty count).
*/

describe('flake reporter fixture: self-skipping spec', function() {
  it('skips itself', function() {
    this.skip();
  });
});
