'use strict';

/*
  Twelve workspace contracts used to assert that the stylesheet contained an
  `@media (prefers-reduced-transparency: reduce)` block. All twelve passed while
  every one of those eighteen blocks did nothing: they set a background to the
  value the element already had, and turned off a backdrop-filter that was never
  on. There is no blur anywhere in the compiled stylesheet, and the surfaces they
  targeted resolve to solid #ffffff / #1a1e22.

  Asserting that a media query exists is not the same as asserting the
  preference is honoured, and the difference is exactly what went unnoticed —
  an audit reading the source would have called it supported.

  So the check runs both ways: the stylesheet may not claim to reduce
  transparency it does not have, and may not add translucency without saying
  what happens when the user asks for less of it.
*/

const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');

const stylesheets = [
  {
    name: 'core',
    file: path.join(__dirname, '..', '..', 'public', 'css', 'style.css'),
  },
];

const premium = path.join(__dirname, '..', '..', '..', 'timeoff-premium', 'public', 'css', 'premium.css');

if (fs.existsSync(premium)) {
  stylesheets.push({name: 'premium', file: premium});
}

/*
  Detection is deliberately narrow: a backdrop-filter that actually blurs.

  That is the unambiguous signal of the material this preference is about — a
  surface you read other content through. A tinted table cell
  (rgba(92,114,138,0.12) on a weekend column) or a loading shroud is not: you
  see no content through it, so making it solid helps nobody, and counting it
  would force a rule that changes nothing. Which is the bug this file exists to
  prevent, arrived at from the other side.

  If translucent chrome is ever added with alpha alone and no blur, this will
  not catch it. Naming that limit here is better than a heuristic that guesses
  which alpha values are materials.
*/
const translucencyIn = css => (css.match(/backdrop-filter\s*:\s*(?!none)[^;]+/g) || []);

describe('Reduced transparency is claimed only where it applies', function() {

  stylesheets.forEach(sheet => {

    describe(sheet.name, function() {

      const css = fs.readFileSync(sheet.file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      const claims = (css.match(/@media \(prefers-reduced-transparency: reduce\)/g) || []).length;
      const blurred = translucencyIn(css);
      const hasTranslucency = blurred.length > 0;

      it('reads a stylesheet', function() {
        // Guards both directions below: an empty file would satisfy them.
        expect(css.length).to.be.above(1000);
      });

      it('does not honour a preference it has nothing to apply to', function() {
        if (hasTranslucency) {
          return this.skip();
        }

        expect(claims).to.equal(
          0,
          'the stylesheet claims to reduce transparency but nothing blurs behind it'
        );
      });

      it('says what happens to its translucency when the user asks for less', function() {
        if (!hasTranslucency) {
          return this.skip();
        }

        expect(claims).to.be.above(
          0,
          'translucent surfaces were added without a prefers-reduced-transparency rule: '
          + blurred.slice(0, 3).join(', ')
        );
      });
    });
  });
});
