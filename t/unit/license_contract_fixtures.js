'use strict';

/*
  License contract fixture spec (Phase 8, Plan 08-01 — CONTRACT-02, community
  half).

  Every fixture in license-contract-fixtures/ runs through the REAL verifier
  (lib/features.js) in a FRESH child process per outcome (the oem_gate.js
  runNode model): the child installs the FrozenDate subclass BEFORE
  require('./lib/features') so every clock read inside the verifier sees the
  package's frozen "now" (2026-06-01, D-16), and the license material is fed
  purely through environment injection — exactly how an operator feeds a
  deployment. The child env deletes LEAVEPILOT_LICENSE, TIMEOFF_LICENSE and
  every LEAVEPILOT_LICENSE_* / TIMEOFF_LICENSE_* name inherited from the
  parent before injecting the fixture's own values, so a dirty developer
  shell cannot contaminate an outcome.

  Expectations are NEVER hand-typed: valid and reason are asserted verbatim
  against the fixture's own meta block (meta.expectedReason).
*/

const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const root = path.join(__dirname, '..', '..');
const PKG_DIR = path.join(root, 'license-contract-fixtures');

const FROZEN_ISO = '2026-06-01T00:00:00.000Z';

const LICENSE_PUBLIC_PEM = fs.readFileSync(
  path.join(PKG_DIR, 'keys', 'test-license.public.testkey'), 'utf8');

const loadFixture = name =>
  JSON.parse(fs.readFileSync(path.join(PKG_DIR, name), 'utf8'));

// The child script. Order is load-bearing: FrozenDate is installed and
// crypto.randomUUID pinned BEFORE require('./lib/features') so module-level
// or memoized clock reads inside the verifier are frozen too. The verifier's
// full getLicenseStatus() is printed as JSON for the parent to assert on.
const CHILD_SCRIPT = [
  'const RealDate = Date;',
  'const FROZEN = RealDate.parse(' + JSON.stringify(FROZEN_ISO) + ');',
  'class FrozenDate extends RealDate {',
  '  constructor(...args) { super(...(args.length ? args : [FROZEN])); }',
  '  static now() { return FROZEN; }',
  '}',
  'global.Date = FrozenDate;',
  "const crypto = require('crypto');",
  "crypto.randomUUID = () => '00000000-0000-4000-8000-000000000001';",
  "const features = require('./lib/features');",
  'process.stdout.write(JSON.stringify(features.getLicenseStatus()));',
].join('\n');

function runFixtureOutcome(fixtureName) {
  const fixture = loadFixture(fixtureName);
  const childEnv = Object.assign({}, process.env);

  // Scrub BOTH generations of every license-family name (a dirty parent
  // shell must not leak into an outcome) plus the unprefixed unsigned door.
  Object.keys(childEnv).forEach(key => {
    if (/^(LEAVEPILOT|TIMEOFF)_LICENSE/.test(key) || key === 'ALLOW_UNSIGNED_LICENSES') {
      delete childEnv[key];
    }
  });

  childEnv.NODE_ENV = 'test';
  childEnv.LEAVEPILOT_LICENSE = JSON.stringify(fixture.envelope);
  childEnv.LEAVEPILOT_LICENSE_PUBLIC_KEYS = JSON.stringify({
    'test-license-do-not-trust': LICENSE_PUBLIC_PEM,
  });

  return JSON.parse(childProcess.execFileSync(process.execPath, ['-e', CHILD_SCRIPT], {
    cwd: root,
    env: childEnv,
    encoding: 'utf8',
  }).trim());
}

describe('License contract fixtures (Plan 08-01)', function() {
  this.timeout(10000);

  it('valid.json verifies through the real lib/features.js verifier at the frozen now', function() {
    const fixture = loadFixture('valid.json');
    const status = runFixtureOutcome('valid.json');

    expect(status.valid, 'valid.json -> valid').to.equal(true);
    expect(status.reason, 'valid.json -> reason (verbatim from meta.expectedReason)')
      .to.equal(fixture.meta.expectedReason);
  });
});
