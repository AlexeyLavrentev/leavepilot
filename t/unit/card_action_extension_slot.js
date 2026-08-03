'use strict';

/*
 * The mobile action cell on /requests/ is an edition extension point: core's own
 * revoke/cancel form sits next to whatever an edition puts in the
 * leave_order_actions slot (views/partials/user_requests.hbs). The premium
 * edition fills it with a bare <a class="pull-right btn btn-default btn-xs
 * leave-order-btn">.
 *
 * Two rules used to assume the cell only ever held core's own markup:
 *
 *   - the >=44px tap-target restore named .revoke-btn, so an edition's button
 *     rendered 28px tall directly beneath a 44px sibling;
 *   - containment relied on the wrapper <form> being flex, because bootstrap's
 *     .pull-right{float:right!important} defeats any float:none core writes. A
 *     bare anchor has no form, stayed a float, and left the cell shorter than
 *     its own content.
 *
 * These assertions read the compiled stylesheet, because that is what a browser
 * sees and what the edition depends on.
 */

const fs = require('fs');
const path = require('path');
const expect = require('chai').expect;

describe('Mobile card action cell as an edition extension point', function () {

  // Comments are stripped first: sass keeps /* ... */ in the output, and these
  // particular comments quote CSS at each other, so a brace inside one would
  // otherwise look like the end of a rule.
  const css = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'css', 'style.css'),
    'utf8'
  ).replace(/\/\*[\s\S]*?\*\//g, '');

  // One selector can carry several declaration blocks across the media queries,
  // so every block is collected and the assertions look for the one that matters.
  const rulesFor = selector => {
    const blocks = [];
    let at = css.indexOf(selector + ' {');

    while (at !== -1) {
      blocks.push(css.slice(at, css.indexOf('}', at) + 1));
      at = css.indexOf(selector + ' {', at + 1);
    }

    return blocks;
  };

  const ruleFor = selector => rulesFor(selector)[0] || null;
  const declaresIn = (selector, pattern) => rulesFor(selector).some(rule => pattern.test(rule));

  const ACTION_CELL = '.requests-page .mobile-card-table > tbody > tr > td.mobile-card-action';
  const ACTION_BTN = '.requests-page .mobile-card-table .mobile-card-action .btn';

  it('gives the tap-target floor to every control in the cell, not just core\'s own', function () {
    expect(ruleFor(ACTION_BTN), ACTION_BTN + ' is missing from the compiled stylesheet')
      .to.be.a('string');

    expect(declaresIn(ACTION_BTN, /min-height:\s*44px/)).to.equal(
      true, 'no block for ' + ACTION_BTN + ' declares the 44px floor'
    );
    expect(declaresIn(ACTION_BTN, /min-width:\s*44px/)).to.equal(
      true, 'no block for ' + ACTION_BTN + ' declares the 44px minimum width'
    );
  });

  it('does not bind the floor to a core-only class', function () {
    expect(css).to.not.match(
      /\.requests-page \.mobile-card-table \.mobile-card-action \.revoke-btn \{[^}]*44px/,
      'scoping the 44px floor to .revoke-btn leaves an edition button at 28px beside it'
    );
  });

  it('contains a floated child without relying on a form wrapper', function () {
    const rule = ruleFor(ACTION_CELL);

    expect(rule, ACTION_CELL + ' is missing from the compiled stylesheet').to.be.a('string');

    // A flex item ignores float, which is the only containment that survives
    // bootstrap's .pull-right{float:right!important}.
    expect(rule).to.match(/display:\s*flex/);
    expect(rule).to.match(/flex-direction:\s*column/);
  });

  it('separates stacked controls instead of butting them together', function () {
    expect(ruleFor(ACTION_CELL)).to.match(/gap:/);
  });

  it('still declares the slot core styles for', function () {
    const host = fs.readFileSync(
      path.join(__dirname, '..', '..', 'views', 'partials', 'user_requests.hbs'),
      'utf8'
    );

    expect(host).to.include('leave_order_actions');
    expect(host).to.include('mobile-card-action');
  });
});
