'use strict';

/*
 * Dark appearance for surfaces that are painted by a stylesheet loaded after
 * this one, or by light tokens written directly into a component.
 *
 * bootstrap-datepicker3.standalone.css is pushed into `custom_css`, so it wins
 * ties against `style.css` on order alone. The booking modal wrote the light
 * surface tokens straight into its header, footer and date fieldsets, so dark
 * mode left dark ink on white sheets — the exact surfaces the datepicker opens
 * from.
 */

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const css = fs.readFileSync(
  path.join(__dirname, '..', '..', 'public', 'css', 'style.css'),
  'utf8'
);

function ruleFor(selector) {
  const at = css.indexOf(selector);
  expect(at, 'missing rule for ' + selector).to.be.at.least(0);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

describe('Dark appearance of late-loaded and hand-painted surfaces', function () {
  it('beats the datepicker stylesheet on its own compound selector', function () {
    // `.datepicker.dropdown-menu` is two classes, so `[data-theme] .datepicker`
    // only ties with it and loses on load order.
    expect(css).to.match(
      /\[data-theme=dark\]\s+\.datepicker\.dropdown-menu[^{]*\{[^}]*background:\s*#1f2327/
    );
    expect(css).to.match(
      /\[data-theme=dark\]\s+\.datepicker\.datepicker-dropdown[^{]*\{[^}]*background:\s*#1f2327/
    );
  });

  it('keeps day numbers readable against the dark popup', function () {
    const days = ruleFor('[data-theme=dark] .datepicker table tr td');
    expect(days).to.match(/color:\s*#e6edf2/);
    expect(css).to.match(
      /\[data-theme=dark\][^{]*\.datepicker table tr td\.today[^{]*\{[^}]*color:\s*#f5d76e/
    );
  });

  it('recolours the popup callout arrows with the popup itself', function () {
    expect(css).to.contain('[data-theme=dark] .datepicker.dropdown-menu::before');
    expect(css).to.contain('[data-theme=dark] .datepicker.dropdown-menu::after');
  });

  it('darkens the booking modal chrome and its date fieldsets', function () {
    for (const selector of [
      '[data-theme=dark] .book-leave-modal .modal-header',
      '[data-theme=dark] .book-leave-modal .modal-footer',
      '[data-theme=dark] .book-leave-date-field',
    ]) {
      expect(css, selector).to.contain(selector);
    }

    expect(css).to.match(
      /\[data-theme=dark\][^{]*\.book-leave-date-field[^{]*\{[^}]*background:\s*#1f2327/
    );
    expect(css).to.match(
      /\[data-theme=dark\][^{]*\.book-leave-date-field legend[^{]*\{[^}]*color:\s*#e6edf2/
    );
  });
});
