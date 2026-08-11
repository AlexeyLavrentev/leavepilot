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

  /*
    EULA §2 names the source of rights for each edition - §2.1 sends the
    Community Edition to LICENSE.md with the precedence clause, §2.2 grants
    the Premium rights, and §3 is scoped to the Premium Edition by plan 01-10 -
    but it never gathers the relationship between LICENSE.md (the Elastic
    License 2.0) and this EULA into one explicit statement. The reader has to
    infer which document grants what, and how the §3 restrictions interact
    with ELv2's own Limitations. The lawyer (Q2 in
    .planning/legal-review-request.md) asked for this to be stated explicitly,
    not derived.

    Kept as a test rather than done once. The key terms "LICENSE.md",
    "Elastic License 2.0", "Community Edition" and "Premium" are already
    spread across §2.1 and §2.2, so a guard that only checked for their
    presence anywhere in §2 would stay green on the current incomplete EULA.
    What makes this enforceable is requiring the relationship under its OWN
    heading - one that carries a relate/relationship/interaction marker
    alongside a document name - and then reading the block under that heading
    for the full set of terms. Today no such heading exists, so the heading
    and block assertions are red; once §2.3 is added they go green, and the
    §2.1 precedence clause they lean on is pinned by the third assertion.

    Sufficiency of the statement for the lawyer's criterion is a legal
    judgment that cannot be derived from code; the spec covers the mechanical
    part (a dedicated section exists and carries the right terms), and the
    sufficiency-by-essence check is left to human verification.
  */
  describe('the explicit relationship between LICENSE.md and this EULA', function() {

    const eula = (function() {
      try {
        return read('docs/EULA.md');
      } catch (error) {
        return null;
      }
    })();

    const relationshipBlock = (function() {
      const text = String(eula);
      const lines = text.split('\n');
      const start = lines.findIndex(line =>
        /^#+\s/.test(line)
        && /relate|relationship|interaction/i.test(line)
        && /LICENSE|Elastic License|ELv2|EULA/i.test(line)
      );
      if (start === -1) {
        return { heading: '', body: '' };
      }
      let end = lines.length;
      for (let i = start + 1; i < lines.length; i += 1) {
        if (/^#+\s/.test(lines[i]) || /^---\s*$/.test(lines[i])) {
          end = i;
          break;
        }
      }
      return { heading: lines[start], body: lines.slice(start + 1, end).join('\n') };
    })();

    it('has a heading that names the relationship between LICENSE.md and this EULA', function() {
      expect(
        relationshipBlock.heading,
        'no EULA heading carries a relate/relationship/interaction marker alongside LICENSE/Elastic License/ELv2/EULA - the relationship is still derived, not stated'
      ).to.be.a('string').that.is.not.empty;
    });

    it('states the relationship in the block under that heading', function() {
      expect(
        relationshipBlock.body.trim().length,
        'the relationship heading is present but its block is empty - the heading alone does not state the relationship'
      ).to.be.above(0);

      expect(
        relationshipBlock.body,
        'the relationship block no longer names the Community Edition'
      ).to.match(/Community Edition/);

      expect(
        relationshipBlock.body,
        'the relationship block no longer names the Premium Edition'
      ).to.match(/Premium/);

      expect(
        relationshipBlock.body,
        'the relationship block no longer names the Elastic License 2.0 or LICENSE.md as the Community Edition grant'
      ).to.match(/Elastic License 2\.0|LICENSE\.md/);

      expect(
        relationshipBlock.body,
        'the relationship block no longer says how the two documents interact or govern each other'
      ).to.match(/govern|interact|add|apply/i);
    });

    it('keeps the §2.1 precedence clause that resolves Community Edition overlaps', function() {
      expect(
        String(eula),
        'the §2.1 clause "Where this EULA and LICENSE.md disagree ... LICENSE.md governs" is gone - §2.3 supplements it, it does not replace it'
      ).to.match(/LICENSE\.md governs/);
    });
  });

  /*
    README used to restate the ELv2 hosted-or-managed-service ban and then
    narrow it to a sale-of-access scenario - «то есть продавать им доступ».
    Neither LICENSE.md nor docs/licensing-faq.md sets any condition on payment:
    the licence forbids providing the software to third parties as a hosted or
    managed service regardless of whether access is sold. README travels in
    every npm tarball, so the softer reading ships with the product.

    Kept as a test rather than done once. The next author of the licence
    paragraph will phrase the boundary in their own words and has no reason to
    compare it to LICENSE.md, so a narrowing gloss would come back with nothing
    failing. The guard finds the hosted-service line in README, reads the
    passage it sits in (the line plus the next, to catch a wrap), and rejects
    sale-of-access lexemes in that passage.
  */
  describe('how README states the hosted-or-managed-service boundary', function() {

    const readme = (function() {
      try {
        return read('README.md');
      } catch (error) {
        return null;
      }
    })();

    const passage = (function() {
      const lines = String(readme).split('\n');
      const i = lines.findIndex(line => /hosted or managed service/i.test(line));
      if (i === -1) {
        return '';
      }
      return lines.slice(i, i + 2).join(' ');
    })();

    // Sale-of-access lexemes next to the hosted-service ban - «продавать
    // доступ» and its forms. LICENSE.md names no condition on payment, so this
    // class of word in the licence-restriction passage is the narrowing to
    // reject. The guard is scoped to the passage, not the whole file: a sale
    // mentioned elsewhere in README is not the licence being narrowed.
    const saleOfAccessLexeme = /продавать|продаж/iu;

    it('restates the hosted-or-managed-service boundary somewhere', function() {
      expect(
        passage.length,
        'README no longer names the hosted-or-managed-service boundary, so the guard lost its line'
      ).to.be.above(0);
    });

    it('does not narrow the hosted-service ban to a sale of access', function() {
      expect(
        passage,
        'README narrows the ELv2 hosted-service ban to a sale-of-access scenario - LICENSE.md sets no condition on payment, and the narrowing ships in every npm tarball'
      ).not.to.match(saleOfAccessLexeme);
    });
  });

  /*
    The product is distributed under the Elastic License 2.0, which is not an
    OSI-approved licence. Calling it "open-source" on a delivered surface is
    therefore legally inaccurate: the reader, and the licence scanner reading
    OCI metadata or the npm registry, infers a grant the licence does not give.
    The accurate term is "source-available", the phrasing CONTRIBUTING.md
    already carries next to the DCO certificate.

    README travels in every npm tarball, the OCI description label travels in
    every built image, the OCI annotations travel in every published manifest,
    and the package.json description field travels in every registry lookup -
    so a drifted "open-source" label ships with the product even when the
    repository root declares Elastic-2.0.

    CONTRIBUTING.md is deliberately not one of the surfaces below. It
    reproduces the Developer Certificate of Origin verbatim, and clause (a)
    of that certificate says "the open source license indicated in the file" -
    an edited certificate is no longer the certificate everyone else has
    read, so the legitimate mention has to stay. The teeth assertion below
    pins that mention in place: without it, leaving CONTRIBUTING.md out of
    labelSurfaces would guard nothing, and the guard could go green on a
    cleaned-out repository.

    package.json is checked separately because it is JSON, not prose: a line
    scanner over the whole file would surface every key and string, and the
    description field is the only place the product itself is labelled there.
  */
  describe('how the product is labelled on delivered surfaces', function() {

    const productLabelledOpenSource = /open[\s-]source/i;

    const labelSurfaces = surfaces.concat(['.github/workflows/publish-community-container.yml']);

    const labelOffenders = labelSurfaces.reduce((found, surface) => {
      read(surface).split('\n').forEach((line, index) => {
        if (productLabelledOpenSource.test(line)) {
          found.push(surface + ':' + (index + 1) + ': ' + line.trim());
        }
      });

      return found;
    }, []);

    it('has delivered surfaces to check', function() {
      // The README, every docs/*.md, both Dockerfiles and the publish workflow
      // are the surfaces whose "open-source" label ships outside the project.
      expect(
        labelSurfaces.length,
        'the guard lost its input, and a guard with nothing to check is green'
      ).to.be.above(20);
    });

    it('does not label the product "open-source" on any delivered surface', function() {
      expect(
        labelOffenders,
        'these lines call the product "open-source", but Elastic License 2.0 is not OSI-approved - the accurate term is "source-available"'
      ).to.deep.equal([]);
    });

    it('does not label the product "open-source" in the package.json description', function() {
      const description = require('../../package.json').description;

      expect(
        description,
        'package.json description labels the product "open-source" - the npm registry would show the inaccurate term to every lookup'
      ).not.to.match(productLabelledOpenSource);
    });

    it('still has the DCO-verbatim "open source" mention CONTRIBUTING.md carries', function() {
      const contributing = read('CONTRIBUTING.md');

      expect(
        productLabelledOpenSource.test(contributing),
        'CONTRIBUTING.md no longer carries the DCO-verbatim "open source" mention, so leaving it out of labelSurfaces guards nothing'
      ).to.equal(true);
    });
  });
});
