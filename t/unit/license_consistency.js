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

  /*
    The terms an incoming contribution is made on live in CONTRIBUTING.md and
    are enforced by the dco job in .github/workflows/core-ci.yml. Text without
    the gate is a paragraph nobody keeps; the gate without the text is a wall
    with no explanation. Asserted here because the two drift apart the same way
    the licence and the documents did - by one of them being edited alone.

    CONTRIBUTING.md is not one of the surfaces above and must not become one:
    it is a file where naming licensing terms is legitimate by construction.
  */
  describe('the terms an incoming contribution is made on', function() {

    const contributing = (function() {
      try {
        return read('CONTRIBUTING.md');
      } catch (error) {
        return null;
      }
    })();

    it('exists', function() {
      expect(
        contributing,
        'CONTRIBUTING.md is gone, and the dco job rejects pull requests on terms nobody can read'
      ).to.be.a('string');
    });

    it('asks for the trailer the CI gate rejects pull requests without', function() {
      expect(
        String(contributing),
        'CONTRIBUTING.md no longer asks for the sign-off the dco job enforces'
      ).to.include('Signed-off-by');

      expect(
        String(contributing),
        'CONTRIBUTING.md no longer tells an author how to fix commits it has already rejected'
      ).to.include('git rebase --signoff');
    });

    it('states the grant of rights first, and names the same licensor', function() {
      const grant = String(contributing).search(/grant of rights/i);
      const signOff = String(contributing).indexOf('Signed-off-by');

      expect(grant, 'CONTRIBUTING.md no longer states what rights a contribution grants').to.be.above(-1);
      expect(
        signOff,
        'the sign-off is described before the grant it accepts, so a contributor signs terms not yet read'
      ).to.be.above(grant);

      expect(
        String(contributing),
        'the grant names a different licensor than LICENSE.md and NOTICE do'
      ).to.include(licensor);
    });
  });

  /*
    EULA §3 "License Restrictions" used to address "the Software" - the term §1
    defines as BOTH editions - so its reverse-engineering and competing-service
    bans narrowed what the Elastic License 2.0 permits for the Community
    Edition. The precedence clause in §2.1 resolves the conflict in LICENSE.md's
    favour but does not remove the contradiction, so the scoping is asserted by
    text inside §3 itself: an intro paragraph under the heading names the
    Premium Edition, and keeps the notice-preservation ban (item 3) in force for
    both editions, because LICENSE.md imposes the same on the Community Edition.

    Kept as a test rather than done once. Item 1 already reads "the Premium
    Edition source code", so a guard that only checks "§3 contains Premium
    Edition" would stay green on the drifted text. The intro paragraph between
    the §3 heading and "You MAY NOT:" is the load-bearing slice: it is empty
    today and only appears once §3 is scoped, which is why Test 2 asserts it
    specifically rather than the section as a whole.
  */
  describe('the restrictions EULA §3 places on the Premium Edition', function() {

    const eula = (function() {
      try {
        return read('docs/EULA.md');
      } catch (error) {
        return null;
      }
    })();

    const section3 = (function() {
      const text = String(eula);
      const start = text.indexOf('## 3. License Restrictions');
      if (start === -1) {
        return '';
      }
      const afterStart = text.indexOf('## 4.', start);
      if (afterStart === -1) {
        return '';
      }
      return text.slice(start, afterStart);
    })();

    const intro = (function() {
      const slice = String(section3);
      const heading = slice.indexOf('## 3. License Restrictions');
      if (heading === -1) {
        return '';
      }
      const headingEnd = slice.indexOf('\n', heading);
      if (headingEnd === -1) {
        return '';
      }
      const youMayNot = slice.indexOf('You MAY NOT:', headingEnd);
      if (youMayNot === -1) {
        return '';
      }
      return slice.slice(headingEnd + 1, youMayNot);
    })();

    it('has a §3 License Restrictions section to scope', function() {
      expect(
        section3.length,
        'the §3 slice is gone from docs/EULA.md, and a guard with nothing to check is green'
      ).to.be.above(0);
    });

    it('scopes §3 to the Premium Edition in an intro paragraph under the heading', function() {
      expect(
        intro.trim().length,
        'no intro paragraph between the §3 heading and "You MAY NOT:" - the scoping lives inside §3, not in the §2.1 precedence clause'
      ).to.be.above(0);

      expect(
        intro,
        'the intro paragraph no longer names the Premium Edition, so §3 still addresses both editions'
      ).to.match(/Premium Edition/);

      expect(
        intro,
        'the intro paragraph no longer keeps the notice-preservation ban (item 3) in force for both editions, which LICENSE.md requires of the Community Edition too'
      ).to.match(/both Editions/);
    });

    it('addresses the reverse-engineering restriction to the Premium Edition', function() {
      const reverse = String(section3).split('\n').find(line => /reverse engineer/i.test(line));

      expect(
        reverse,
        'the reverse-engineering item is gone from §3, so this guard lost its line'
      ).to.be.a('string');

      expect(
        reverse,
        '§3 still restricts reverse engineering on "the Software" instead of scoping it to the Premium Edition'
      ).to.match(/Premium Edition/);

      expect(
        reverse,
        '§3 still addresses the reverse-engineering restriction to "the Software" - the term §1 defines as both editions - and narrows what ELv2 permits for the Community Edition'
      ).not.to.match(/\bthe Software\b/);
    });

    it('addresses the competing-services restriction to the Premium Edition', function() {
      const competing = String(section3).split('\n').find(line => /competing services/i.test(line));

      expect(
        competing,
        'the competing-services item is gone from §3, so this guard lost its line'
      ).to.be.a('string');

      expect(
        competing,
        '§3 still restricts competing services on "the Software" instead of scoping it to the Premium Edition'
      ).to.match(/Premium Edition/);

      expect(
        competing,
        '§3 still addresses the competing-services restriction to "the Software" - the term §1 defines as both editions - and narrows what ELv2 permits for the Community Edition'
      ).not.to.match(/\bthe Software\b/);
    });
  });
});
