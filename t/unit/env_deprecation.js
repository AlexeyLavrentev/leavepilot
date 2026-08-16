'use strict';

var expect = require('chai').expect;
var envResolver = require('../../lib/env_resolver');

// TIMEOFF_* keys the specs in this suite set on process.env. Snapshotted in
// beforeEach, deleted for a clean start, and restored in afterEach (scaffold
// copied from t/unit/branding.js:7-31).
var TOUCHED_KEYS = ['TIMEOFF_LICENSE', 'TIMEOFF_SECRET_KEY'];
var originalEnv = {};

describe('env_resolver deprecation warn-once', function() {
  beforeEach(function() {
    TOUCHED_KEYS.forEach(function(key) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    });
    envResolver.reset();
  });

  afterEach(function() {
    TOUCHED_KEYS.forEach(function(key) {
      if (typeof originalEnv[key] === 'undefined') {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    });
  });

  it('describeDeprecations returns old to new pairs for TIMEOFF_ names present', function() {
    var fakeEnv = {
      TIMEOFF_LICENSE: 'x',
      TIMEOFF_PREMIUM_MODULE: 'y',
      LEAVEPILOT_EDITION: 'z',
      OTHER: 'q',
    };

    expect(envResolver.describeDeprecations(fakeEnv)).to.deep.equal([
      { old: 'TIMEOFF_LICENSE', new: 'LEAVEPILOT_LICENSE' },
      { old: 'TIMEOFF_PREMIUM_MODULE', new: 'LEAVEPILOT_PREMIUM_MODULE' },
    ]);
  });

  it('describeDeprecations returns empty array when no TIMEOFF_ names set', function() {
    expect(envResolver.describeDeprecations({ LEAVEPILOT_LICENSE: 'x' })).to.deep.equal([]);
  });

  it('reportDeprecations emits exactly one warn carrying every old to new pair', function() {
    var captured = [];
    var fakeLogger = { warn: function() { captured.push(Array.prototype.slice.call(arguments).join(' ')); } };
    process.env.TIMEOFF_LICENSE = 'x';
    process.env.TIMEOFF_SECRET_KEY = 'y';

    envResolver.reportDeprecations(process.env, fakeLogger);

    expect(captured.length).to.equal(1);
    expect(captured[0]).to.contain('TIMEOFF_LICENSE → LEAVEPILOT_LICENSE');
    expect(captured[0]).to.contain('TIMEOFF_SECRET_KEY → LEAVEPILOT_SECRET_KEY');
  });

  it('reportDeprecations does not re-warn on a second call, and reset re-arms it', function() {
    var captured = [];
    var fakeLogger = { warn: function() { captured.push(Array.prototype.slice.call(arguments).join(' ')); } };
    process.env.TIMEOFF_LICENSE = 'x';
    process.env.TIMEOFF_SECRET_KEY = 'y';

    envResolver.reportDeprecations(process.env, fakeLogger);
    expect(captured.length).to.equal(1);

    // Second call in the same process must not re-warn (module-level warned flag).
    envResolver.reportDeprecations(process.env, fakeLogger);
    expect(captured.length).to.equal(1);

    // reset() re-arms the flag, so the next call warns again.
    envResolver.reset();
    envResolver.reportDeprecations(process.env, fakeLogger);
    expect(captured.length).to.equal(2);
  });

  it('reportDeprecations emits nothing when no deprecated names are present', function() {
    var captured = [];
    var fakeLogger = { warn: function() { captured.push(Array.prototype.slice.call(arguments).join(' ')); } };

    envResolver.reportDeprecations(process.env, fakeLogger);

    expect(captured.length).to.equal(0);
  });

  it('the warning never contains env VALUES (secret-leakage control)', function() {
    var captured = [];
    var fakeLogger = { warn: function() { captured.push(Array.prototype.slice.call(arguments).join(' ')); } };
    process.env.TIMEOFF_LICENSE = 'SUPER_SECRET_VALUE';

    envResolver.reportDeprecations(process.env, fakeLogger);

    expect(captured.length).to.equal(1);
    expect(captured[0]).to.not.contain('SUPER_SECRET_VALUE');
    // The name and mapping MUST still be present (only the value is suppressed).
    expect(captured[0]).to.contain('TIMEOFF_LICENSE → LEAVEPILOT_LICENSE');
  });
});
