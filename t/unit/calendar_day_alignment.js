'use strict';

/*
  A calendar day is two table cells wide - a morning half and an afternoon half,
  so that a half-day leave can colour one of them - while the column heading
  above spans both. The day number is rendered into the morning cell only, so
  left where it falls it prints in the left half of its own day, under the gap
  between two headings rather than under its own.

  Two things were wrong with the correction for that.

  A day inside a leave renders a button rather than a span, and the rules
  carrying the correction name `span`, so the button stood where the layout
  happened to put it. Measured on a real calendar, ink centre against cell
  centre: 4px inside a leave against 9px everywhere else, so a coloured period's
  numbers printed 5px left of their neighbours and the run of days looked bent
  where the colour started.

  And 9px was a measurement, not a derivation. Half a cell is what centres the
  number over the day, which is 11.5px at the width this table is usually laid
  out at and something else at any other width, so every number in the calendar
  sat 2px left of its own heading.

  Neither shows up in a screenshot of one cell. So the two offsets are checked
  against each other and against the geometry they are supposed to produce,
  rather than against a number that would just be the same magic value written
  down in a third place.
*/

const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');

const scss = fs.readFileSync(path.join(root, 'scss', 'main.scss'), 'utf8');

const css = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

const cell = fs.readFileSync(
  path.join(root, 'views', 'partials', 'calendar_cell.hbs'),
  'utf8'
);

const teamViewCell = fs.readFileSync(
  path.join(root, 'views', 'partials', 'team_view_calendar_cell.hbs'),
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

/*
  Both offsets have to be readable as a share of the cell, or they cannot be
  compared to each other at all - which is the whole point of expressing them
  that way. A pixel value returns null and fails the assertion that reads it,
  which is the intended outcome: a fixed pixel offset is right at one table
  width and wrong at every other.

  sass folds calc(50% + 50%) to 100%, so both forms have to parse.
*/
const asShareOfCell = value => {
  if (!value) return null;

  const terms = value.replace(/^calc\(/, '').replace(/\)$/, '').split('+').map(term => term.trim());

  if (!terms.every(term => /^\d+(\.\d+)?%$/.test(term))) return null;

  return terms.reduce((total, term) => total + parseFloat(term), 0);
};

describe('Calendar day numbers', function() {

  describe('the premise', function() {

    it('splits a day into a morning and an afternoon cell', function() {
      [cell, teamViewCell].forEach(template => {
        expect(template).to.include('half_1st');
        expect(template).to.include('half_2nd');
      });
    });

    it('renders the number as a button inside a leave and a span outside one', function() {
      [cell, teamViewCell].forEach(template => {
        expect(template).to.match(/leave_obj[\s\S]{0,600}calendar-leave-details-trigger/);
        expect(template).to.include('{{else}}');
        expect(template).to.match(/\{\{else\}\}[\s\S]{0,600}<span/);
      });
    });

    it('renders every calendar through those two partials', function() {
      // A calendar that built its own cells would not be a day of two halves,
      // and a share-of-the-cell offset would put its numbers somewhere else.
      ['calendar.hbs', 'bankHolidays.hbs'].forEach(view => {
        expect(fs.readFileSync(path.join(root, 'views', view), 'utf8'))
          .to.include('{{> calendar_cell');
      });

      expect(
        fs.readFileSync(path.join(root, 'views', 'partials', 'user_details', 'calendar.hbs'), 'utf8')
      ).to.include('{{> calendar_cell');

      expect(
        fs.readFileSync(path.join(root, 'views', 'partials', 'team_view_table.hbs'), 'utf8')
      ).to.include('{{> team_view_calendar_cell');
    });
  });

  describe('one offset, read by both elements', function() {

    it('declares it once', function() {
      expect(scss).to.match(/\$calendar-day-number-nudge:\s*[^;]+;/);
    });

    /*
      This is the guard that matters. The offset came apart in the first place
      because it was written out under one selector and not the other, and a
      compiled stylesheet cannot tell a shared value from two that happen to
      agree today.
    */
    it('is read rather than repeated, by the span and by the trigger', function() {
      const readers = scss.match(/left\s*:\s*[^;]*\$calendar-day-number-nudge/g) || [];

      expect(readers.length).to.be.at.least(
        3,
        'a rule places a day number with something other than the shared offset'
      );

      const spanRules = scss.match(/td\.calendar_cell span \{[^}]*\}/g) || [];

      expect(spanRules.length).to.be.above(0);
      spanRules.forEach(rule => {
        if (/left\s*:/.test(rule)) {
          expect(rule).to.include('$calendar-day-number-nudge');
        }
      });
    });
  });

  describe('the geometry it produces', function() {

    // A full-width block with centred text: its own centre is half a cell in
    // from wherever `left` puts it.
    const spanLeft = asShareOfCell(declaration(rulesFor('td.calendar_cell span'), 'left'));
    // Absolutely positioned and pulled back by half its own width, so `left` is
    // where the number itself lands.
    const triggerLeft = asShareOfCell(declaration(rulesFor('.calendar-leave-details-trigger'), 'left'));

    it('keeps the span a full-width block with its text centred', function() {
      const blocks = rulesFor('td.calendar_cell span');

      expect(declaration(blocks, 'display')).to.equal('block');
      expect(declaration(blocks, 'text-align')).to.equal('center');
    });

    it('keeps the trigger pulled back by half its own width', function() {
      expect(declaration(rulesFor('.calendar-leave-details-trigger'), 'transform'))
        .to.match(/translate\(\s*-50%\s*,\s*-50%\s*\)/);
    });

    it('expresses both as a share of the cell rather than a pixel count', function() {
      expect(spanLeft, 'the day number is placed by a fixed pixel offset').to.be.a('number');
      expect(triggerLeft, 'the trigger is placed by a fixed pixel offset').to.be.a('number');
    });

    /*
      A day is two equal cells, so its middle is the far edge of the first one:
      100% of the cell the number sits in.
    */
    it('lands a plain number in the middle of its day', function() {
      expect(spanLeft + 50).to.equal(100);
    });

    it('lands a number inside a leave in the same place', function() {
      expect(triggerLeft).to.equal(spanLeft + 50);
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
