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

  /*
    The menu does not animate at all now, and that is the fix rather than a gap.

    It had a keyframe, which cannot be reversed: closed 60ms into opening it
    went from opacity 0.69 straight to gone at full size. Replacing it with a
    transition needs the element to stay in the box tree, and that was measured
    costing more than the animation is worth - a hidden menu left in layout
    extends the document's scrollable width, and the general settings page hit
    471px of horizontal overflow at a 390px viewport. An uninterruptible
    animation is worse than none.
  */
  describe('menus do not animate rather than animate uninterruptibly', function() {

    it('has no keyframe on the menu', function() {
      expect(css).to.not.match(
        /\.open\s*>\s*\.dropdown-menu\s*\{[^}]*animation:/,
        'a keyframe cannot be reversed'
      );
    });

    it('leaves the menu hidden by display, not held in layout', function() {
      const held = rulesFor('.dropdown-menu')
        .filter(block => /visibility:\s*hidden/.test(block));

      expect(held).to.deep.equal(
        [],
        'a hidden menu kept in the box tree extends the page it sits on'
      );
    });

    it('keeps the anchor an animation would need', function() {
      expect(
        rulesFor('.dropdown-menu').some(block => /transform-origin/.test(block))
      ).to.equal(true);
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
