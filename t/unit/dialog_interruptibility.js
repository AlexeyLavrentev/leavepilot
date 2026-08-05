'use strict';

/*
  "Every animation must be interruptible and redirectable at any moment."

  Two halves, and only one of them was broken by inspection.

  The dialog's own motion was already fine: a CSS transition interpolates from
  whatever the value currently is, so interrupting a close and reopening was
  measured moving 0.97 -> 0.97 -> 1, with no jump back to the starting scale.
  Nothing here changes that, and this file does not pretend it needed changing.

  What was broken:

  1. The menu used a keyframe animation. A keyframe cannot be reversed - a menu
     closed 60ms into opening went from opacity 0.69 straight to gone at full
     size. A transition interpolates from where it is, which needs the element
     to stay in the box tree, so visibility replaces Bootstrap's display toggle.

  2. The dialog lost the last request. Bootstrap decides synchronously and
     finishes on a transition that lands later, and the late half acts on stale
     intent. Interrupting a close by asking to open again measured

       show > hide > show > hidden > shown > shown > hidden

     - ending closed although opening was asked for last. The user presses the
     button during the closing animation and nothing opens.
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

const rulesFor = selector => {
  const blocks = [];
  let at = css.indexOf(selector + ' {');

  while (at !== -1) {
    blocks.push(css.slice(at, css.indexOf('}', at) + 1));
    at = css.indexOf(selector + ' {', at + 1);
  }

  return blocks;
};

describe('Interruptibility', function() {

  describe('menus can be reversed mid-flight', function() {

    it('animates with a transition, never a keyframe', function() {
      // A keyframe plays to its end or stops dead; neither is reversible.
      expect(css).to.not.match(
        /\.open\s*>\s*\.dropdown-menu\s*\{[^}]*animation:/,
        'the menu is back on a keyframe animation, which cannot reverse'
      );

      const closed = rulesFor('.dropdown-menu').find(block => /transition:/.test(block));

      expect(closed, 'no .dropdown-menu rule declares a transition').to.be.a('string');
      expect(closed).to.match(/transition:[^;]*opacity/);
      expect(closed).to.match(/transition:[^;]*transform/);
    });

    /*
      display: none stops a transition dead, so the closing half would still
      cut. visibility keeps the element in the box tree while removing it from
      hit-testing and the tab order, which is what display was there for.
    */
    it('keeps the menu in the box tree so the closing half can animate', function() {
      const closed = rulesFor('.dropdown-menu').find(block => /visibility:\s*hidden/.test(block));

      expect(closed, 'the menu still relies on display for hiding').to.be.a('string');
      expect(closed).to.match(/display:\s*block/);
      expect(closed).to.match(/pointer-events:\s*none/);
    });

    it('defers the hide until the shrink has finished, and shows at once', function() {
      const closed = rulesFor('.dropdown-menu').find(block => /visibility/.test(block));
      const open = rulesFor('.open > .dropdown-menu')[0];

      // visibility is not interpolable: it is switched at the end on the way
      // out, and immediately on the way in.
      expect(closed).to.match(/transition:[^;]*visibility 0s[^;]*0\.\d+s/);
      expect(open).to.match(/transition-delay:\s*0s/);
    });
  });

  describe('the last request is the one that happens', function() {

    it('records what was asked for, not what Bootstrap decided', function() {
      expect(script).to.match(/'show\.bs\.modal'[\s\S]{0,120}record\(this, 'shown'\)/);
      expect(script).to.match(/'hide\.bs\.modal'[\s\S]{0,120}record\(this, 'hidden'\)/);
    });

    /*
      Reading Bootstrap's own opinion is not enough: after this race it believes
      the modal is shown while the element is hidden, so a retry returns early
      and strands .in on a display:none element. The element is what the reader
      sees, so the element is what gets compared.
    */
    it('compares against the element, not against Bootstrap\'s belief', function() {
      expect(script).to.match(/classList\.contains\('in'\)/);
      expect(script).to.match(/getComputedStyle\(element\)\.display/);
    });

    it('clears the flag that would make its own retry a no-op', function() {
      expect(script).to.match(/internals\.isShown\s*=/);
    });

    /*
      Every correction settles into another shown/hidden, which asks for another.
      Measured at six state changes for one interruption before this guard, and
      app code listening on shown.bs.modal ran on every one of them.
    */
    it('corrects once rather than chasing itself', function() {
      expect(script).to.match(/CORRECTING/);
      expect(script).to.match(/if \(\$element\.data\(CORRECTING\)\) \{\s*return;/);
    });

    it('reads Bootstrap back a frame later, after it has finished writing', function() {
      expect(script).to.match(/reconcileSoon/);
      expect(script).to.match(/requestAnimationFrame[\s\S]{0,160}reconcile\(element\)/);
    });
  });

  describe('what was already right', function() {

    it('leaves the dialog on a transition, which interpolates from where it is', function() {
      const closed = rulesFor('.modal.fade .modal-dialog').find(block => /transition:/.test(block));

      expect(closed, 'the dialog lost its transition').to.be.a('string');
      expect(closed).to.match(/transition:[^;]*transform/);
      expect(css).to.not.match(
        /\.modal\.fade \.modal-dialog\s*\{[^}]*animation:/,
        'a keyframe on the dialog would undo the one thing that already worked'
      );
    });
  });
});
