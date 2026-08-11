'use strict';

/*
  The documents disagreed with the licence. README.md and docs/EULA.md both
  stated that the Community Edition is distributed under the inherited upstream
  licence, and docs/EULA.md pointed at a root LICENSE file, while the repository
  root declared the Elastic License 2.0 and no such file existed any more. Both
  statements were read on review and neither was noticed: a licence claim is
  prose, it sits far from the code the reviewer came for, and nothing fails when
  it goes stale.

  What replaced it: the licence text lives in LICENSE.md alone, the licensing
  history lives in NOTICE alone, and every document that used to restate either
  now links to them. The reading of the "hosted or managed service" limitation
  lives in docs/licensing-faq.md, which is the one document allowed to interpret
  the licence rather than point at it.

  Kept as a test rather than done once. Restating a licence in prose is the
  natural way to answer "what am I allowed to do" in a README, the next person
  to write that paragraph will have no reason to check it against the root, and
  the claim would then be shipped - README.md travels in every npm tarball, and
  the OCI label travels in every image - while the repository quietly says
  something else.
*/

const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');

const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

/*
  Everything that makes a licence statement to somebody outside the project.
  LICENSE.md, NOTICE and CONTRIBUTING.md are deliberately absent: they are the
  files where the inherited licence has to be named, because the inherited
  licence itself requires its permission notice to be carried along.

  Both Dockerfiles are in scope. The OCI label is the machine-readable licence
  claim, and it is what corporate image scanners read - leaving it out would
  keep the guard green while the published image said otherwise.
*/
const surfaces = ['README.md', 'Dockerfile', 'Dockerfile.portal'].concat(
  fs.readdirSync(path.join(root, 'docs'))
    .filter(name => name.endsWith('.md'))
    .map(name => path.posix.join('docs', name))
);

/*
  Word boundaries, not substring search. "LIMITED" contains the three letters of
  the inherited licence name, and docs/EULA.md line 81 has
  "INCLUDING BUT NOT LIMITED TO:" in its warranty disclaimer - a guard that went
  red there would be switched off or buried in exemptions within a week.
*/
const inheritedLicenceName = /\bMIT\b/;

/*
  Both halves of this one are load-bearing. Without the lookahead every mention
  of LICENSE.md would be an offender, because a dot is not a word character and
  \b matches right after LICENSE. With the word boundary, the licence-key
  environment variables (TIMEOFF_LICENSE, PORTAL_LICENSE_PRIVATE_KEY_FILE,
  ALLOW_UNSIGNED_LICENSES and some sixty more across docs/) are not offenders,
  because an underscore is a word character and there is no boundary there.
*/
const removedRootLicenceFile = /\bLICENSE\b(?!\.md)/;

/*
  The single exemption, and it is a line rather than a file. This one names the
  licence of LicenseAPI - a third-party product being evaluated - not the
  licence of this software, so it is a legitimate mention. Exempting the whole
  file would let the next drifted claim inside it pass in silence.
*/
const thirdPartyProductLine = {
  file: 'docs/licensing-architecture.md',
  text: 'MongoDB + React, MIT). Ключевые проблемы для клиентского сценария:'
};

const isExempt = (surface, line) =>
  surface === thirdPartyProductLine.file && line.trim() === thirdPartyProductLine.text;

const offendersFor = pattern => surfaces.reduce((found, surface) => {
  read(surface).split('\n').forEach((line, index) => {
    if (pattern.test(line) && !isExempt(surface, line)) {
      found.push(surface + ':' + (index + 1) + ': ' + line.trim());
    }
  });

  return found;
}, []);

// One constant, checked against all three files that carry it. Replacing the
// natural person with a legal entity is then three edits and this line, and
// forgetting one of the three files fails here rather than in a contract.
const licensor = 'Alexey Lavrentev';

const scenarioTableHeader = '| Scenario | Verdict | Why |';

describe('The documents agree with the licence', function() {

  it('has surfaces to check', function() {
    expect(
      surfaces.length,
      'the guard lost its input, and a guard with nothing to check is green'
    ).to.be.above(20);
  });

  it('has no document claiming the licence this software no longer carries', function() {
    expect(offendersFor(inheritedLicenceName)).to.deep.equal(
      [],
      'these lines state a licence this software is not distributed under'
    );
  });

  it('has no document pointing at the root licence file that was removed', function() {
    expect(offendersFor(removedRootLicenceFile)).to.deep.equal(
      [],
      'these lines link to a file that no longer exists; the licence text is in LICENSE.md'
    );
  });

  // The assertion above is satisfied by an exemption that guards nothing, so
  // the line it was written for has to still be there and still match.
  it('still has the third-party mention its one exemption was written for', function() {
    const lines = read(thirdPartyProductLine.file).split('\n');
    const found = lines.filter(line => line.trim() === thirdPartyProductLine.text);

    expect(
      found.length,
      'the exempted line is gone from ' + thirdPartyProductLine.file + ', so the exemption is now a hole'
    ).to.equal(1);

    expect(
      inheritedLicenceName.test(thirdPartyProductLine.text),
      'the exempted line no longer matches what it exempts'
    ).to.equal(true);
  });

  // "Nothing claims the old licence" is also true of a Dockerfile with no
  // licence label at all, which is why this is asserted positively.
  it('declares the licence in the image metadata scanners read', function() {
    expect(read('Dockerfile')).to.include(
      'org.opencontainers.image.licenses="Elastic-2.0"',
      'the built image would carry no licence claim, or the wrong one'
    );
  });

  it('names the same licensor in every file that names one', function() {
    ['LICENSE.md', 'NOTICE', 'docs/EULA.md'].forEach(file => {
      expect(read(file), file + ' names a different licensor than the other two').to.include(licensor);
    });
  });

  describe('the reading of the hosted-or-managed-service boundary', function() {

    const faq = (function() {
      try {
        return read('docs/licensing-faq.md');
      } catch (error) {
        return null;
      }
    })();

    it('exists and says what it is', function() {
      expect(faq, 'docs/licensing-faq.md is gone, and NOTICE and README.md both link to it').to.be.a('string');
      expect(faq, 'the document no longer disclaims being legal advice').to.match(/not legal advice/i);
      expect(faq, 'the document no longer says LICENSE.md wins over it').to.match(/LICENSE\.md govern/);
    });

    /*
      Counted inside the block that carries the header rather than over the
      whole file: a second table added later would otherwise break this
      silently, or worse, hold it up after the scenarios themselves were cut.
    */
    it('answers exactly the eight scenarios it was written to answer', function() {
      const block = String(faq).split(/\n\s*\n/).find(part => part.includes(scenarioTableHeader));

      expect(block, 'the scenario table header is gone from docs/licensing-faq.md').to.be.a('string');

      const rows = block.split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('|') && !/^\|[-:| ]+\|?$/.test(line));

      expect(rows.length - 1, 'the scenario table no longer carries eight scenarios').to.equal(8);
    });
  });
});
