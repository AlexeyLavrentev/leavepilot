'use strict';

/*
 * Guards the licence declaration across every place it lives: the machine
 * readable field in package.json, the verbatim licence body in LICENSE.md and
 * the upstream attribution in NOTICE.
 *
 * The package.json assertion carries more weight than it looks. npm does not
 * validate the `license` field at all: a typo such as "Elastic-2.O" passes
 * `npm pack --dry-run` and `npm publish --dry-run` without a single warning,
 * and the value is then read verbatim by dependency scanners and copied into
 * the signed SBOM of the published image. There is no other guard. This spec
 * is it.
 *
 * The licence body is compared against t/fixtures/elastic-license-2.0.txt, and
 * the fixture itself is pinned by sha256 to the published canonical text -
 * without that pin the "reference" could be quietly edited alongside
 * LICENSE.md and the comparison would stay green while both drifted.
 *
 * Only the slice between the markers is compared. The file as a whole carries
 * a header naming the licensor, which the canonical text has no room for: the
 * Elastic License 2.0 defines the licensor abstractly and offers no
 * placeholder.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {expect} = require('chai');
const packageJson = require('../../package.json');

const ROOT = path.join(__dirname, '..', '..');
const BEGIN = '<!-- BEGIN ELASTIC-LICENSE-2.0 -->\n';
const END = '<!-- END ELASTIC-LICENSE-2.0 -->';
const LICENSOR = 'Alexey Lavrentev';
const CANONICAL_SHA256 =
  '48255018b41fc0e965b1115af7e6779bc218bb8a6747d561da800d5022622aa2';

describe('Licence declaration', function() {
  const license = fs.readFileSync(path.join(ROOT, 'LICENSE.md'), 'utf8');
  const fixture = fs.readFileSync(
    path.join(ROOT, 't', 'fixtures', 'elastic-license-2.0.txt'),
    'utf8'
  );
  const notice = fs.readFileSync(path.join(ROOT, 'NOTICE'), 'utf8');
  // The cutoff sentence wraps across lines in NOTICE; collapse runs of
  // whitespace so a single regexp can match the sentence as one string.
  const noticeNormalised = notice.replace(/\s+/g, ' ');

  it('declares the SPDX identifier in package.json', function() {
    expect(
      packageJson.license,
      'npm never warns about a wrong value here, so nothing else catches a typo'
    ).to.equal('Elastic-2.0');
  });

  it('keeps both markers around the canonical body', function() {
    const start = license.indexOf(BEGIN);
    const end = license.indexOf(END);

    expect(start, 'BEGIN marker missing from LICENSE.md').to.be.greaterThan(-1);
    expect(end, 'END marker missing or above BEGIN').to.be.greaterThan(start);
  });

  it('embeds the canonical Elastic License 2.0 body verbatim', function() {
    const start = license.indexOf(BEGIN);
    const end = license.indexOf(END);
    const body = license.slice(start + BEGIN.length, end);

    expect(
      body,
      'the licence body between the markers no longer matches the reference text'
    ).to.equal(fixture);
  });

  it('pins the reference text itself to the published canonical text', function() {
    const digest = crypto.createHash('sha256').update(fixture).digest('hex');

    expect(
      digest,
      'the reference fixture was edited; comparing LICENSE.md against it proves nothing now'
    ).to.equal(CANONICAL_SHA256);
  });

  it('names the licensor in the header, above the untouched body', function() {
    const header = license.slice(0, license.indexOf(BEGIN));

    expect(header, 'the licensor is no longer named in LICENSE.md').to.include(
      LICENSOR
    );
  });

  it('no longer ships the superseded root LICENSE file', function() {
    expect(
      fs.existsSync(path.join(ROOT, 'LICENSE')),
      'the superseded root LICENSE file is back in the tree'
    ).to.equal(false);
  });

  it('keeps the upstream copyright line in NOTICE', function() {
    expect(
      notice,
      'the inherited MIT copyright line was dropped from NOTICE'
    ).to.include('Copyright (c) 2015-2017 TimeOff.Management');
  });

  it('reproduces the inherited permission notice in NOTICE, not just the copyright', function() {
    expect(
      notice,
      'the permission notice was shortened; the inherited licence requires it in full'
    ).to.include(
      'The above copyright notice and this permission notice shall be included in all'
    );
  });

  it('names the Elastic License 2.0 cutoff version in NOTICE, consistently with the history section', function() {
    // The cutoff is read out of NOTICE rather than copied as a constant next
    // to the spec: moving the cutoff without moving the version (or vice
    // versa) must redden the spec, and a constant would let them drift apart
    // silently.
    const cutoffMatch = noticeNormalised.match(
      /Beginning with version (\d+)\.(\d+)\.(\d+), this software is distributed under the Elastic License 2\.0/
    );
    expect(
      cutoffMatch,
      'NOTICE no longer carries the sentence "Beginning with version <x.y.z>, this software is distributed under the Elastic License 2.0"; without it the cutoff this spec compares against is gone'
    ).to.not.equal(null);

    const historyMatch = noticeNormalised.match(
      /up to and including (\d+)\.x were distributed under/
    );
    expect(
      historyMatch,
      'NOTICE no longer names the major that was last distributed under the prior licence; the history section and the cutoff can now drift apart silently'
    ).to.not.equal(null);

    const cutoffMajor = parseInt(cutoffMatch[1], 10);
    const historyMajor = parseInt(historyMatch[1], 10);

    expect(
      historyMajor + 1,
      'the history section names major ' + historyMajor + ' as the last under the prior licence, but the cutoff is major ' + cutoffMajor + ' - moving one without the other rewrites the conditions of already-distributed copies after the fact'
    ).to.equal(cutoffMajor);
  });

  it('declares a version at or above the Elastic License 2.0 cutoff recorded in NOTICE', function() {
    const cutoffMatch = noticeNormalised.match(
      /Beginning with version (\d+)\.(\d+)\.(\d+), this software is distributed under the Elastic License 2\.0/
    );
    expect(
      cutoffMatch,
      'the cutoff sentence is gone from NOTICE, so the version comparison has nothing to compare against'
    ).to.not.equal(null);

    const cutoff = [+cutoffMatch[1], +cutoffMatch[2], +cutoffMatch[3]];
    const declared = packageJson.version.split('.').map(part => parseInt(part, 10));

    let below = false;
    for (let i = 0; i < 3; i++) {
      if (declared[i] < cutoff[i]) { below = true; break; }
      if (declared[i] > cutoff[i]) { break; }
    }

    expect(
      below,
      'package.json declares version ' + packageJson.version + ' but NOTICE sets the Elastic License 2.0 cutoff at ' + cutoff.join('.') + '; a tarball ships both statements in contradiction'
    ).to.equal(false);
  });
});
