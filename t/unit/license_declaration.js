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
});
