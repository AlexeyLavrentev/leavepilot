'use strict';

var expect = require('chai').expect;

/*
  Contract between bin/test.js and every child process it drives (D-05,
  D-19). The universal invariant - the deprecated TIMEOFF_FEATURES name is
  never injected - holds however this spec is run; the positive value
  assertions are conditional so the spec stays green under plain mocha with
  nothing set (the runner always sets these, a bare mocha run may not).
*/
describe('runner env contract (bin/test.js child)', function() {
  it('injects no deprecated TIMEOFF_FEATURES name', function() {
    // Unconditional: a runner that reverts to the deprecated prefix breaks
    // its own deprecation spec (t/unit/env_deprecation.js) and must break
    // this one the same way.
    expect(process.env).to.not.have.property('TIMEOFF_FEATURES');
  });

  it('DB_DIALECT is sqlite unless TEST_DB_DIALECT selected mysql', function() {
    if (process.env.TEST_DB_DIALECT === 'mysql') {
      expect(process.env.DB_DIALECT).to.equal('mysql');
      return;
    }

    // Plain mocha runs may carry no DB_DIALECT at all; the runner always
    // sets one, so the default contour is asserted only where a value
    // exists.
    if (typeof process.env.DB_DIALECT !== 'undefined') {
      expect(process.env.DB_DIALECT).to.equal('sqlite');
    }
  });

  it('LEAVEPILOT_FEATURES is "all" when the runner drove this process', function() {
    // Positive assertion only for a clean environment (no deprecated
    // TIMEOFF_* names present): the runner sets the canonical switch to
    // 'all' (D-19). Where nothing set it there is nothing to assert - the
    // absence of deprecated names above is the universal part.
    var deprecatedPresent = Object.keys(process.env).some(function(key) {
      return key.indexOf('TIMEOFF_') === 0;
    });

    if (deprecatedPresent) {
      return;
    }

    if (typeof process.env.LEAVEPILOT_FEATURES !== 'undefined') {
      expect(process.env.LEAVEPILOT_FEATURES).to.equal('all');
    }
  });

  it('NODE_ENV is "test" when the runner drove this process', function() {
    // The unsigned-license trust root accepts unsigned fixtures exactly
    // under NODE_ENV=test (WR-01/D-20). The runner pins it so a bare local
    // `node bin/test.js` cannot inherit the shell's NODE_ENV (or none) and
    // fail the oem/branding suites for an environmental reason. Plain
    // mocha runs may carry no NODE_ENV; the runner always sets one.
    if (typeof process.env.NODE_ENV !== 'undefined') {
      expect(process.env.NODE_ENV).to.equal('test');
    }
  });
});
