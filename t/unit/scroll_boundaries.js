'use strict';

/*
  "At an edge, resist progressively instead of stopping hard."

  These tables are scrolled by the browser, not by a gesture handler of ours, so
  the resistance is the platform's to give — and on macOS and iOS it does give
  it. What it will not do is keep the gesture in the table: by default the
  overscroll chains outward, and a horizontal flick past the last column is how
  browsers trigger a back navigation on a trackpad. Reaching the edge of a wide
  table could take the reader off the page entirely, which is not a hard stop so
  much as a trapdoor.

  overscroll-behavior-x: contain leaves the scrolling alone and stops the chain,
  so the rubber-band happens in the table.

  Not hand-rolled. A transform-based rubber-band would mean intercepting wheel
  and touch and reimplementing momentum worse than the platform does, and these
  containers hold sticky cells — .team-view-table .left-column-cell, its thead,
  the deducted column — that a transform on their scroll parent would break by
  making it their containing block.

  Only the x axis. Contained on y as well, a two-finger scroll starting over a
  table that does not scroll vertically would stop scrolling the page.
*/

const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');

const stylesheets = [
  {name: 'core', file: path.join(__dirname, '..', '..', 'public', 'css', 'style.css')},
];

const premium = path.join(__dirname, '..', '..', '..', 'timeoff-premium', 'public', 'css', 'premium.css');

if (fs.existsSync(premium)) {
  stylesheets.push({name: 'premium', file: premium});
}

const rulesIn = css => {
  const rules = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;

  while ((match = pattern.exec(css)) !== null) {
    rules.push({selector: match[1].trim().replace(/\s+/g, ' '), body: match[2]});
  }

  return rules;
};

describe('Scroll boundaries', function() {

  stylesheets.forEach(sheet => {

    describe(sheet.name, function() {

      const css = fs.readFileSync(sheet.file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      const scrollers = rulesIn(css).filter(rule => /overflow-x:\s*auto/.test(rule.body));

      it('has horizontally scrollable regions to check', function() {
        // Guards the assertions below: an empty list would satisfy them all.
        expect(scrollers.length).to.be.above(0);
      });

      it('keeps every horizontal overscroll inside the region that owns it', function() {
        const leaking = scrollers
          .filter(rule => !/overscroll-behavior(-x)?:\s*(contain|none)/.test(rule.body))
          .map(rule => rule.selector.slice(-60));

        expect(leaking).to.deep.equal(
          [],
          'these scroll sideways but let the gesture chain out, which is a back '
          + 'navigation waiting to happen'
        );
      });

      /*
        Containing the y axis on a region that does not scroll vertically stops
        the page scrolling when the pointer happens to be over a table.
      */
      it('does not contain an axis these regions do not scroll', function() {
        const overreaching = scrollers
          .filter(rule => !/overflow-y:\s*(auto|scroll)/.test(rule.body))
          .filter(rule => /overscroll-behavior:\s*(contain|none)/.test(rule.body))
          .map(rule => rule.selector.slice(-60));

        expect(overreaching).to.deep.equal(
          [],
          'contained on both axes without scrolling on both: a vertical scroll '
          + 'starting over one of these would not reach the page'
        );
      });

      /*
        The blind spot, named rather than left to be rediscovered: this reads
        our stylesheet, so a region whose overflow is declared by Bootstrap is
        invisible to it. .table-responsive is exactly that — it scrolls on
        /users/ and was found by reading the computed style on a real page, not
        here. It is pinned by name because the rule that contains it carries no
        overflow of its own for the check above to match on.
      */
      it('contains the wrappers whose overflow comes from Bootstrap', function() {
        if (sheet.name !== 'core') {
          return this.skip();
        }

        const wrapper = rulesIn(css)
          .filter(rule => /(^|,|\s)\.table-responsive\s*$/.test(rule.selector))
          .find(rule => /overscroll-behavior(-x)?:\s*(contain|none)/.test(rule.body));

        expect(wrapper, '.table-responsive lets a swipe past the last column chain out')
          .to.be.an('object');
      });

      it('leaves the scrolling itself to the browser', function() {
        // A hand-rolled rubber-band would show up as a transform on the scroll
        // container, which is also what would break the sticky cells inside it.
        scrollers.forEach(rule => {
          expect(rule.body).to.not.match(
            /transform:\s*translate/,
            rule.selector.slice(-50) + ' moves its own scroll container'
          );
        });
      });
    });
  });
});
