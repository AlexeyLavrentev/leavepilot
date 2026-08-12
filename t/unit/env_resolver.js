'use strict';

var expect = require('chai').expect;
var envResolver = require('../../lib/env_resolver');

// Keys the specs in this suite touch. Snapshotted in beforeEach, deleted for a
// clean start, and restored in afterEach (scaffold copied from
// t/unit/branding.js:7-31).
var TOUCHED_KEYS = ['LEAVEPILOT_LICENSE', 'TIMEOFF_LICENSE', 'BRAND_NAME'];
var originalEnv = {};

describe('env_resolver resolve/getEnv', function() {
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

  it('canonical generation wins when both are set', function() {
    process.env.LEAVEPILOT_LICENSE = 'new';
    process.env.TIMEOFF_LICENSE = 'old';

    expect(envResolver.resolve('LICENSE')).to.equal('new');
  });

  it('deprecated generation is used when canonical is absent', function() {
    process.env.TIMEOFF_LICENSE = 'old';

    expect(envResolver.resolve('LICENSE')).to.equal('old');
  });

  it('returns undefined when neither generation is set', function() {
    expect(envResolver.resolve('LICENSE')).to.equal(undefined);
  });

  it('getEnv passes neutral names through', function() {
    process.env.BRAND_NAME = 'Acme';

    expect(envResolver.getEnv('BRAND_NAME')).to.equal('Acme');
    expect(envResolver.getEnv('UNSET_THING')).to.equal(undefined);
  });

  it('GENERATIONS is ordered oldest to newest and CANONICAL_PREFIX is the newest', function() {
    expect(envResolver.GENERATIONS).to.deep.equal([
      { prefix: 'TIMEOFF_', generation: 1 },
      { prefix: 'LEAVEPILOT_', generation: 2 },
    ]);
    expect(envResolver.CANONICAL_PREFIX).to.equal('LEAVEPILOT_');
  });
});
