'use strict';

/*
  A calendar day is two table cells wide - a morning half and an afternoon half,
  so that a half-day leave can colour one of them - while the column heading
  above spans both. The day number is rendered into the morning cell only, so
  left where it falls it prints in the left half of its own day, under the gap
  between two headings rather than under its own. Every day number is pushed
  right to correct for that.

  A day that falls inside a leave renders a button instead of a span, and the
  rules that carry the correction name `span`. The button therefore stood where
  the layout happened to put it, and the numbers inside a coloured period
  printed 5px left of the numbers in the days either side - measured on a real
  calendar as an ink centre 4px right of the cell centre inside a leave against
  9px everywhere else.

  Neither half of this is visible in a screenshot of one cell: it only shows up
  as a row of numbers that stops lining up where the colour starts. So the two
  offsets are pinned against each other here rather than pinned to 9px, which
  would just be the same number written down in a third place.
*/

const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(
  path.join(__dirname, '..', '..', 'public', 'css', 'style.css'),
  'utf8'
).replace(/\/\*[\s\S]*?\*\//g, '');

const cell = fs.readFileSync(
  path.join(__dirname, '..', '..', 'views', 'partials', 'calendar_cell.hbs'),
  'utf8'
);

const teamViewCell = fs.readFileSync(
  path.join(__dirname, '..', '..', 'views', 'partials', 'team_view_calendar_cell.hbs'),
  'utf8'
);

// Every block for a selector, not the first: these are declared more than once,
// and reading the first is how an assertion ends up checking an unrelated rule.
const rulesFor = selector => {
  const blocks = [];
  let at = css.indexOf(selector + ' {');

  while (at !== -1) {
    blocks.push(css.slice(at, css.indexOf('}', at) + 1));
    at = css.indexOf(selector + ' {', at + 1);
  }

  return blocks;
};

const declaration = (blocks, property) => blocks
  .map(block => {
    const found = block.match(new RegExp('(?:^|[;{])\\s*' + property + '\\s*:\\s*([^;}]+)'));

    return found ? found[1].trim() : null;
  })
  .filter(Boolean)
  .pop();

describe('Calendar day numbers', function() {

  describe('the premise', function() {

    it('splits a day into a morning and an afternoon cell', function() {
      expect(cell).to.include('half_1st');
      expect(cell).to.include('half_2nd');
    });

    it('renders the number as a button inside a leave and a span outside one', function() {
      [cell, teamViewCell].forEach(template => {
        expect(template).to.match(/leave_obj[\s\S]{0,600}calendar-leave-details-trigger/);
        expect(template).to.include('{{else}}');
        expect(template).to.match(/\{\{else\}\}[\s\S]{0,600}<span/);
      });
    });
  });

  describe('both elements carry the same correction', function() {

    const nudge = declaration(rulesFor('td.calendar_cell span'), 'left');
    const trigger = declaration(rulesFor('.calendar-leave-details-trigger'), 'left');

    it('pushes the plain number off its own cell centre', function() {
      expect(nudge, 'no horizontal offset on the day number').to.be.a('string');
      expect(parseFloat(nudge)).to.be.above(0);
    });

    /*
      The trigger is out of flow - it has to be, or the descender space under an
      inline-level 24px target pushes a day with a leave to 42px against the
      31px of every other row - so it is centred and then moved by the same
      amount, rather than inheriting the offset the way an in-flow span does.
    */
    it('moves the trigger to the same place', function() {
      expect(trigger, 'no horizontal placement on the trigger').to.be.a('string');
      expect(trigger).to.equal('calc(50% + ' + nudge + ')');
    });

    it('leaves nothing standing where the layout happened to put it', function() {
      // `left: 3px` was the button's static position copied down as though it
      // were a chosen offset. Any bare small pixel value here is that again.
      expect(trigger).to.not.match(
        /^\d+(\.\d+)?px$/,
        'the trigger is placed by a raw offset rather than relative to the centre'
      );
    });
  });

  describe('the row height that made the trigger out of flow', function() {

    it('keeps the trigger out of the line box', function() {
      const position = declaration(rulesFor('.calendar-leave-details-trigger'), 'position');

      expect(position).to.equal(
        'absolute',
        'back in flow, a day with a leave is taller than every other row'
      );
    });

    it('keeps a positioned cell for it to be placed against', function() {
      expect(
        rulesFor('td.calendar_cell').some(block => /position:\s*relative/.test(block)),
        'the trigger would be placed against the page instead of its cell'
      ).to.equal(true);
    });
  });
});
