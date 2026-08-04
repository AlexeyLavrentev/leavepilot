'use strict';

/*
  Every custom property in scss/main.scss was a hand-written hex inside a page
  scope — 360 of them, not one from a variable — so a role picked up a slightly
  different value each time it was copied to a new page. The differences were a
  digit in one channel, invisible on their own, which is exactly why they piled
  up: --*-accent-edge held #2b7da8 on three pages and #2b7db5 on a fourth,
  --*-accent-soft held #eaf4fb, #e7f3fb and #e9f2f8, and the dark overlay was
  #15191d on four pages against #1f2327 on two.

  The roles with a clear majority now come from one variable each. This holds
  them there, and reports any new role that starts drifting the same way.

  Roles whose values genuinely vary per page are listed as tolerated rather than
  silently skipped: --*-border-strong and --*-surface-subtle have no majority to
  consolidate towards, so picking one would invent a design decision instead of
  removing an accident.
*/

const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'scss', 'main.scss'),
  'utf8'
).replace(/\/\*[\s\S]*?\*\//g, '');

// Roles consolidated onto a variable. Each must have exactly one value, and it
// must arrive by interpolation rather than as a literal.
const CONSOLIDATED = [
  'accent-edge',
  'accent-soft',
  'surface-raised',
  'surface-overlay',
  'shadow-strong',
];

// Roles that legitimately differ from page to page. Named so the list is a
// decision rather than an omission.
const VARIES_BY_PAGE = ['border-strong', 'surface-subtle'];

const declarationsFor = role => {
  const pattern = new RegExp(
    // The value may itself contain braces now that these interpolate a
    // variable, so it is matched up to the semicolon rather than excluding them.
    '^\\s*(--[a-z0-9-]*' + role + ')\\s*:\\s*([^;]+);',
    'gm'
  );

  const found = [];
  let match;

  while ((match = pattern.exec(SOURCE)) !== null) {
    found.push({name: match[1], value: match[2].trim()});
  }

  return found;
};

describe('Design token drift', function() {

  it('reads a stylesheet with tokens in it', function() {
    // Guards every assertion below: a regex that matched nothing would make
    // them all pass while checking nothing.
    expect(declarationsFor('accent-edge').length).to.be.above(3);
  });

  CONSOLIDATED.forEach(role => {

    describe('--*-' + role, function() {

      it('is declared from a variable everywhere, never as a literal', function() {
        const literals = declarationsFor(role).filter(d => !d.value.includes('#{'));

        expect(literals.map(d => d.name + ': ' + d.value)).to.deep.equal(
          [],
          'these hard-code a value that has a variable, which is how the last drift started'
        );
      });

      it('resolves to one variable per theme, not several near-identical ones', function() {
        const used = new Set(
          declarationsFor(role)
            .map(d => (d.value.match(/#\{\$([a-z0-9-]+)\}/) || [])[1])
            .filter(Boolean)
            // The onboarding page runs its own scale on purpose.
            .filter(name => !name.startsWith('onboarding-'))
        );

        expect(Array.from(used).sort().length).to.be.at.most(
          2,
          'more than a light and a dark variable feed this role: ' + Array.from(used).join(', ')
        );
      });
    });
  });

  it('keeps the roles that vary per page out of the consolidated list', function() {
    VARIES_BY_PAGE.forEach(role => {
      expect(CONSOLIDATED).to.not.include(role);
      expect(declarationsFor(role).length).to.be.above(
        1,
        role + ' no longer varies per page and could be consolidated'
      );
    });
  });

  /*
    The compiled stylesheet is what a browser reads, so the consolidation is
    checked there too: a variable that is shadowed or redefined would still
    produce two values in the output.
  */
  it('emits one value per theme for each consolidated role', function() {
    const compiled = fs.readFileSync(
      path.join(__dirname, '..', '..', 'public', 'css', 'style.css'),
      'utf8'
    ).replace(/\/\*[\s\S]*?\*\//g, '');

    CONSOLIDATED.forEach(role => {
      const pattern = new RegExp('^\\s*--(?!onboarding-)[a-z0-9-]*' + role + '\\s*:\\s*([^;]+);', 'gm');
      const values = new Set();
      let match;

      while ((match = pattern.exec(compiled)) !== null) {
        values.add(match[1].trim());
      }

      expect(Array.from(values).length, role + ' emits: ' + Array.from(values).join(' | '))
        .to.be.at.most(2);
    });
  });
});
