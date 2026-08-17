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
const REVOCATION_PUBLIC_PEM = fs.readFileSync(
  path.join(PKG_DIR, 'keys', 'test-revocation.public.testkey'), 'utf8');

const loadFixture = name =>
  JSON.parse(fs.readFileSync(path.join(PKG_DIR, name), 'utf8'));

// The license fixtures the matrix iterates: every package JSON except the
// manifest and the revocation list itself (the list is not a license — it is
// consumed via env by the revoked / revocation-miss outcomes). Derived from
// the package directory, not hand-typed, so the spec cannot drift from the
// package (anti-drift principle: the CI job runs this spec, which iterates
// the package).
const LICENSE_FIXTURES = fs.readdirSync(PKG_DIR)
  .filter(name => /\.json$/.test(name) && name !== 'MANIFEST.json' && name !== 'revocation-list.json')
  .sort();

// meta.env names beyond the defaults (LEAVEPILOT_LICENSE + the key ring) the
// child must inject, and where each value comes from. An unknown name in a
// fixture's meta.env fails the run — it would mean the package and the spec
// drifted apart.
const EXTRA_ENV_SOURCES = {
  LEAVEPILOT_LICENSE_REVOCATION_LIST: () =>
    JSON.stringify(loadFixture('revocation-list.json').envelope),
  LEAVEPILOT_LICENSE_REVOCATION_PUBLIC_KEY: () => REVOCATION_PUBLIC_PEM,
};

// Expected validity per reason. Only two reasons keep the license valid: the
// plain 'valid' case and 'expired_in_grace' (D-03: grace keeps valid:true —
// premium features live, custom_branding suppressed). Every other reason in
// the matrix fails closed.
const REASON_VALIDITY = {
  valid: true,
  expired_in_grace: true,
};

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

  // Additional env the fixture's meta block demands (revocation cases).
  (fixture.meta.env || []).forEach(name => {
    const source = EXTRA_ENV_SOURCES[name];
    if (!source) {
      throw new Error(fixtureName + ': meta.env names "' + name
        + '" but the spec has no source for it — package/spec drift');
    }
    childEnv[name] = source();
  });

  return JSON.parse(childProcess.execFileSync(process.execPath, ['-e', CHILD_SCRIPT], {
    cwd: root,
    env: childEnv,
    encoding: 'utf8',
  }).trim());
}

describe('License contract fixtures (Plan 08-01)', function() {
  this.timeout(10000);

  it('has license fixtures to iterate (surfaces-exist)', function() {
    expect(
      LICENSE_FIXTURES.length,
      'the package walk resolved to too few license fixtures — the matrix would be green for the wrong reason'
    ).to.be.above(5);
    expect(LICENSE_FIXTURES).to.include('valid.json');
    expect(LICENSE_FIXTURES).to.include('revocation-miss.json');
  });

  // Outcome matrix: every license fixture through the REAL verifier, reason
  // asserted verbatim against the fixture's own meta.expectedReason, validity
  // derived from that reason (only 'valid' and 'expired_in_grace' stay
  // valid — every other reason fails closed).
  LICENSE_FIXTURES.forEach(name => {
    it(name + ' yields its meta.expectedReason through the real lib/features.js verifier at the frozen now', function() {
      const fixture = loadFixture(name);
      const status = runFixtureOutcome(name);

      expect(status.valid, name + ' -> valid (reason "' + fixture.meta.expectedReason + '")')
        .to.equal(REASON_VALIDITY[fixture.meta.expectedReason] === true);
      expect(status.reason, name + ' -> reason (verbatim from meta.expectedReason)')
        .to.equal(fixture.meta.expectedReason);
    });
  });

  it('non-vacuous grace tooth: grace.json genuinely lands valid AND inGrace AND expired_in_grace (cannot silently degrade into plain-expired)', function() {
    const status = runFixtureOutcome('grace.json');

    expect(status.valid, 'grace fixture IS a valid license').to.equal(true);
    expect(status.inGrace, 'grace fixture IS inside the grace window').to.equal(true);
    expect(status.reason).to.equal('expired_in_grace');
    expect(status.graceEndsAt, 'grace surfaces graceEndsAt').to.be.a('string');
  });

  it('revocation-miss positive control: the signed list is consulted and leaves the license valid with list timestamps', function() {
    const status = runFixtureOutcome('revocation-miss.json');
    const list = loadFixture('revocation-list.json');

    expect(status.valid, 'miss license stays valid').to.equal(true);
    expect(status.reason).to.equal('valid');
    expect(status.revocationListIssuedAt, 'status must surface revocationListIssuedAt — its absence would mean the list check was skipped')
      .to.equal(list.envelope.payload.issuedAt);
    expect(status.revocationListExpiresAt)
      .to.equal(list.envelope.payload.expiresAt);
  });
});

/*
  MANIFEST teeth (Plan 08-01 Task 3, D-19) — the five tooth classes of the
  dialect_sensitive_manifest / vendored_integrity precedents applied to the
  license contract package: surfaces-exist, hash recompute with a FULL report
  (no early exit), bidirectional non-phantom set equality (MANIFEST.json
  self-excluded), contractVersion == document header, and a synthetic tamper
  proof that never touches disk.
*/

const crypto = require('crypto');

const loadManifest = () => JSON.parse(
  fs.readFileSync(path.join(PKG_DIR, 'MANIFEST.json'), 'utf8'));

const sha256Hex = buffer =>
  crypto.createHash('sha256').update(buffer).digest('hex');

// Recompute EVERY listed hash and report ALL mismatches — a full report is
// more useful than the first thing that broke (verify-artifact-licenses.sh
// discipline). Deterministic order: keys sorted, never lexicographic on the
// formatted message.
function collectHashMismatches(filesMap) {
  return Object.keys(filesMap).sort().filter(key => {
    const target = path.join(root, key);
    if (!fs.existsSync(target)) {
      return true;
    }
    return sha256Hex(fs.readFileSync(target)) !== filesMap[key].sha256;
  }).map(key => key + ': pinned ' + filesMap[key].sha256
    + (fs.existsSync(path.join(root, key))
      ? ' != actual ' + sha256Hex(fs.readFileSync(path.join(root, key)))
      : ' but the file is MISSING'));
}

// Files on disk the MANIFEST must cover: everything under the package plus
// the root LICENSE-CONTRACT.md, excluding MANIFEST.json itself
// (self-hashing is impossible — Pitfall 9).
function onDiskExpectation() {
  const entries = fs.readdirSync(PKG_DIR, {recursive: true})
    .filter(rel => fs.statSync(path.join(PKG_DIR, rel)).isFile() && rel !== 'MANIFEST.json')
    .map(rel => 'license-contract-fixtures/' + String(rel).split(path.sep).join('/'));
  entries.push('LICENSE-CONTRACT.md');
  return entries.sort();
}

describe('License contract MANIFEST (Plan 08-01)', function() {
  const manifest = loadManifest();

  it('pins a non-trivial file set (surfaces-exist)', function() {
    expect(
      Object.keys(manifest.files).length,
      'the manifest pins too few files — an emptied or broken manifest would make every other tooth vacuously green'
    ).to.be.above(10);
  });

  it('every pinned SHA256 matches the bytes on disk (full report, no early exit)', function() {
    const mismatches = collectHashMismatches(manifest.files);
    expect(
      mismatches,
      'these files drifted from MANIFEST.json — restore them or regenerate the manifest deliberately via node license-contract-fixtures/generate.js (D-20 procedure):\n'
        + mismatches.join('\n')
    ).to.deep.equal([]);
  });

  it('files map and on-disk package are set-equal in BOTH directions (MANIFEST self-excluded)', function() {
    const pinned = Object.keys(manifest.files).sort();
    const onDisk = onDiskExpectation();
    const listedMissing = pinned.filter(key => onDisk.indexOf(key) === -1);
    const unlistedPresent = onDisk.filter(key => pinned.indexOf(key) === -1);

    expect(listedMissing, 'MANIFEST lists files that do not exist (phantoms):\n' + listedMissing.join('\n')).to.deep.equal([]);
    expect(unlistedPresent, 'files exist on disk but are NOT pinned in MANIFEST.json (silent additions — regenerate the manifest or remove them):\n' + unlistedPresent.join('\n')).to.deep.equal([]);
  });

  it('contractVersion equals the Contract-Version of the LICENSE-CONTRACT.md header', function() {
    const documentHead = fs.readFileSync(path.join(root, 'LICENSE-CONTRACT.md'), 'utf8');
    const match = documentHead.match(/^Contract-Version:\s*(\d+\.\d+)/m);

    expect(match, 'LICENSE-CONTRACT.md header must carry a Contract-Version: <major.minor> line').to.not.equal(null);
    expect(
      manifest.contractVersion,
      'MANIFEST.contractVersion must equal the document header version (D-19)'
    ).to.equal(match[1]);
  });

  it('synthetic tamper tooth: one flipped hash byte is flagged by the same checker (in-memory only)', function() {
    const pristine = collectHashMismatches(manifest.files);
    expect(pristine, 'the real manifest must recompute clean before the tamper proof means anything').to.deep.equal([]);

    const tamperedFiles = JSON.parse(JSON.stringify(manifest.files));
    const someKey = Object.keys(tamperedFiles).sort()[0];
    const hash = tamperedFiles[someKey].sha256;
    const flipped = (hash[0] === '0' ? '1' : '0') + hash.slice(1);
    tamperedFiles[someKey].sha256 = flipped;

    const flagged = collectHashMismatches(tamperedFiles);
    expect(flagged.length, 'a tampered pin must be flagged').to.equal(1);
    expect(flagged[0]).to.contain(someKey);
    expect(flagged[0]).to.contain(flipped);

    // Disk untouched: the real manifest still recomputes clean.
    expect(collectHashMismatches(manifest.files)).to.deep.equal([]);
  });
});
