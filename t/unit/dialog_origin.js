'use strict';

/*
  "If something disappears one way, we expect it to emerge from where it came."

  A dialog that scales up from the middle of the screen severs the link between
  the control pressed and the thing that appeared. Bootstrap's own animation
  slides it down from the top of the viewport, which says nothing about the
  button at all.

  global.js measures the trigger and writes a transform-origin onto the dialog;
  the stylesheet gives it a scale so that origin means something. Neither half
  is any use alone, and neither is obviously broken by inspection - a missing
  origin just looks like a dialog opening from the centre - so both are pinned
  here.
*/

const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');

const script = fs.readFileSync(
  path.join(__dirname, '..', '..', 'public', 'js', 'global.js'),
  'utf8'
);

const css = fs.readFileSync(
  path.join(__dirname, '..', '..', 'public', 'css', 'style.css'),
  'utf8'
).replace(/\/\*[\s\S]*?\*\//g, '');

// All blocks for a selector, not the first: several of these are declared more
// than once, and matching the first is how an assertion ends up reading a rule
// that has nothing to do with what it is checking.
const rulesFor = selector => {
  const blocks = [];
  let at = css.indexOf(selector + ' {');

  while (at !== -1) {
    blocks.push(css.slice(at, css.indexOf('}', at) + 1));
    at = css.indexOf(selector + ' {', at + 1);
  }

  return blocks;
};

const ruleFor = selector => rulesFor(selector).find(block => /transform|scale|origin/.test(block))
  || rulesFor(selector)[0]
  || null;

describe('Dialogs open from what opened them', function() {

  describe('the measurement', function() {

    it('takes the trigger from the event rather than guessing', function() {
      expect(script).to.include("'show.bs.modal'");
      expect(script).to.include('event.relatedTarget');
    });

    it('writes a transform-origin onto the dialog', function() {
      expect(script).to.match(/transformOrigin\s*=\s*origin/);
    });

    /*
      Bootstrap does not show the modal until its backdrop has finished fading,
      so the dialog measures 0x0 for the whole of that - traced as zero across
      six straight frames on a real open. Waiting on a frame count instead of
      the measurement is how the first attempt at this silently did nothing.
    */
    it('waits for a measurable dialog, not for a fixed number of frames', function() {
      expect(script).to.match(/ANCHOR_DEADLINE_MS/);
      expect(script).to.not.match(
        /attemptsLeft/,
        'a frame budget cannot know when the backdrop has finished'
      );
    });

    it('bounds the wait, so a dialog that never opens leaves nothing running', function() {
      const deadline = script.match(/ANCHOR_DEADLINE_MS\s*=\s*(\d+)/);

      expect(deadline, 'no deadline is declared').to.be.an('array');
      expect(Number(deadline[1])).to.be.above(150);   // past Bootstrap's backdrop fade
      expect(Number(deadline[1])).to.be.below(2000);
    });

    it('falls back to the centre when nothing triggered it', function() {
      // Opened from script rather than a control: pointing somewhere arbitrary
      // is worse than not pointing.
      expect(script).to.match(/if \(!trigger\)[\s\S]{0,200}transformOrigin = ''/);
    });
  });

  describe('the animation that gives the origin meaning', function() {

    it('scales the dialog instead of sliding it in from the top', function() {
      const closed = ruleFor('.modal.fade .modal-dialog');

      expect(closed, 'the dialog has no closed-state rule').to.be.a('string');
      expect(closed).to.match(/scale\(/);
      expect(closed).to.not.match(/translate\(0, *-25%\)/, "Bootstrap's slide is still in play");
    });

    /*
      Bootstrap declares shown.bs.modal on a 300ms fallback timer. With the
      transition also at 300ms the two race, and a control measured on "shown"
      came back 39.97px instead of 40. Finishing first makes shown mean shown.
    */
    it('settles before Bootstrap calls the dialog shown', function() {
      const closed = ruleFor('.modal.fade .modal-dialog');
      const durations = (closed.match(/(\d*\.?\d+)s/g) || []).map(parseFloat);

      expect(durations.length).to.be.above(0);
      durations.forEach(duration => {
        expect(duration, 'a transition at or past the 300ms fallback').to.be.below(0.3);
      });
    });

    it('anchors menus to the corner they hang from', function() {
      expect(
        rulesFor('.dropdown-menu').some(block => /transform-origin:\s*top left/.test(block)),
        'no .dropdown-menu rule anchors to its top-left corner'
      ).to.equal(true);
      expect(css).to.match(/\.dropdown-menu-right[\s\S]{0,120}transform-origin:\s*top right/);
    });
  });

  /*
    Reduced motion keeps the feedback and drops the travel. Scaling a dialog out
    of a button is exactly the vestibular movement the preference is about.
  */
  describe('reduced motion', function() {
    const block = css.slice(
      css.indexOf('@media (prefers-reduced-motion: reduce)', css.indexOf('.modal.in .modal-dialog'))
    ).slice(0, 600);

    it('drops the scale and keeps a cross-fade', function() {
      expect(block).to.include('.modal');
      expect(block).to.match(/transform:\s*none/);
      expect(block).to.match(/opacity/);
    });

    it('stops the menu animation too', function() {
      expect(block).to.match(/animation:\s*none/);
    });
  });
});
