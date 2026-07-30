'use strict';

/*
 * Stage 8D — Requests Workspace contract (/requests/).
 *
 * Verifies the redesign scoped under .requests-page WITHOUT touching the five
 * locked contracts (requests_bulk_action_ui, route/requests_bulk_action,
 * mobile_tables, requests_popover_trigger, leave_details_popover_trigger) — those
 * are exercised by their own files. This file asserts ONLY the new Stage 8D
 * surface: scoped surfaces, history-table mobile-card wiring, status chips, and
 * the compiled scoped CSS (tokens under .requests-page, press cascade,
 * reduced-motion incl. :hover:active, scoped mobile-card chrome, px type).
 */

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf8');
}

// Extract the first balanced { ... } block following `selector` in `source`.
// (dart-sass normalises selectors in compiled CSS, so this reads the SCSS source
// verbatim — the same approach used by the Stage 8C contract.)
function blockOf(source, selector) {
  const start = source.indexOf(selector);
  expect(start, 'expected selector ' + selector + ' in source').to.be.greaterThan(-1);
  let depth = 0, i = source.indexOf('{', start);
  const begin = i;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(begin, i + 1);
}

describe('Requests workspace contract (Stage 8D)', function () {
  const view = read('views/requests.hbs');
  const grouped = read('views/partials/user_requests_grouped.hbs');
  const history = read('views/partials/user_requests.hbs');
  const scss = read('scss/main.scss');
  const css = read('public/css/style.css');

  describe('page structure and scoping', function () {
    it('keeps the scoped main.requests-page', function () {
      expect(view).to.match(/<main id="main-content" class="requests-page" tabindex="-1">/);
    });
    it('keeps the result-feedback anchor unchanged', function () {
      expect(view).to.include('id="requests-feedback"');
      expect(view).to.include('data-focus-alert-on-load');
    });
    it('uses the page-heading pattern for the h1 title', function () {
      expect(view).to.include('class="page-heading"');
      expect(view).to.match(/<h1>\{\{t "requests\.messagesTitle"/);
    });
    it('keeps both section headings with their locked id + class', function () {
      expect(view).to.include('id="requests-to-approve-heading" class="main-row_header requests-section-heading"');
      expect(view).to.include('id="requests-all-absences-heading" class="main-row_header requests-section-heading"');
    });
    it('wraps the approval area in a raised surface', function () {
      expect(view).to.match(/<section class="requests-approval surface">/);
    });
    it('wraps the history area in its own surface', function () {
      expect(view).to.match(/<section class="requests-history">/);
    });
  });

  describe('year surfaces (grouped partial)', function () {
    it('wraps each year group in a raised surface with a year heading', function () {
      expect(grouped).to.match(/<section class="requests-year-surface surface">/);
      expect(grouped).to.match(/<h2 class="requests-year-heading">\{\{this\.year\}\}<\/h2>/);
    });
    it('keeps the deduction line and the user_requests include', function () {
      expect(grouped).to.include('{{t "requests.deductedFromAllowance"}}');
      expect(grouped).to.include('{{this.total_deduction}}');
      expect(grouped).to.include('{{> user_requests leaves=this.leaves');
    });
  });

  describe('history table — opt-in mobile-card wiring (no global layout change)', function () {
    it('gates the mobile-card classes behind the mobile_cards param', function () {
      // The shared partial must NOT add mobile-card-table unconditionally — that would change
      // /calendar/ and user-details too. The classes activate only when mobile_cards is truthy.
      expect(history).to.match(/\{\{#if mobile_cards\}\}mobile-card-table requests-history-table\{\{\/if\}\}/);
      expect(history).to.match(/\{\{#if mobile_cards\}\}mobile-card-table-container\{\{\/if\}\}/);
    });
    it('gates every data-label behind the mobile_cards param', function () {
      // data-labels are only needed for the mobile card layout; on the legacy table they'd be dead.
      for (const key of [
        'requests.datesColumn',
        'requests.type',
        'requests.deducted',
        'requests.approvedBy',
        'requests.comment',
        'requests.status',
      ]) {
        expect(history).to.include('data-label="{{t \'' + key + '\'}}"', 'missing data-label for ' + key);
      }
    });
    it('keeps the scroll hint for the legacy (non-mobile) consumers', function () {
      // calendar/user-details still render the horizontally-scrollable table + its hint.
      expect(history).to.include('requests.scrollTable');
    });
    it('requests.hbs opts the history into the mobile-card layout via mobile_cards=1', function () {
      expect(view).to.match(/user_requests_grouped[^\}]*mobile_cards=1/);
    });
    it('the grouped partial forwards mobile_cards to the inner user_requests partial', function () {
      // Inside {{#each grouped_leaves}} the mobile_cards param lives one level up (the partial
      // root), so the forward is ../mobile_cards.
      expect(grouped).to.match(/mobile_cards=\.\.\/mobile_cards/);
    });
    it('keeps the locked leave-details date trigger markup', function () {
      expect(history).to.include('leave-details-summary-trigger interactive-leave-details-summary-trigger leave-details-date-trigger');
      expect(history).to.include('<span class="sr-only">{{t "leave.leaveSummary"}}: </span>');
      expect(history).to.include('{{> leave_dates leave=this}}');
      expect(history).to.include('data-tom-leave-dates="1"');
    });
    it('keeps the leave-order premium slot and the row status class', function () {
      expect(history).to.include('{{#> leave_order_actions leave=this logged_user=../logged_user}}{{/leave_order_actions}}');
      expect(history).to.include('class="leave-request-row"');
      expect(history).to.include('leave-request-row-status');
    });
  });

  describe('select-all — visible mobile target (P1)', function () {
    it('wraps the desktop thead select-all so it can be hidden on mobile', function () {
      // The thead is sr-only-clipped on mobile, leaving the desktop checkbox invisible-but-
      // focusable. Wrap it so CSS display:none removes it from the Tab order <=768px.
      expect(view).to.match(/<span class="bulk-select-desktop">\s*<input[^>]*class="bulk-select-all"/);
    });
    it('provides a visible mobile-only select-all (also .bulk-select-all for sync)', function () {
      expect(view).to.match(/<label class="bulk-select-mobile">\s*<input[^>]*class="bulk-select-all"/);
    });
    it('keeps exactly one .bulk-select-all that is visible at desktop width', function () {
      // The mobile label is display:none on desktop, so only the thead checkbox shows there.
      // Both carry .bulk-select-all (the controller syncs them).
      const matches = view.match(/class="bulk-select-all"/g) || [];
      expect(matches.length).to.equal(2, 'expected 2 .bulk-select-all (desktop thead + mobile), got ' + matches.length);
    });
  });

  describe('POST endpoints render in the DOM (not just route source)', function () {
    it('renders the cancel form in the DOM when the row is the user\'s own pending leave', function () {
      // The cancel form lives in the shared history partial and must POST to /requests/cancel/.
      expect(history).to.include("action='/requests/cancel/'");
    });
  });

  describe('page heading has no duplicate subtitle (P2)', function () {
    it('keeps only the h1 in the page heading (no lead duplicating the section h2)', function () {
      expect(view).to.not.match(/<p class="lead">\{\{t "requests\.toApproveTitle"\}\}/);
    });
  });

  describe('status chips', function () {
    it('wraps the history row status in a calm chip with a modifier + label', function () {
      // pending/approved/rejected render the existing localized text inside a chip span
      // carrying a state modifier so the chip is calm text (not color-only state).
      expect(history).to.include('request-status-chip request-status--pending');
      expect(history).to.include('request-status-chip request-status--approved');
      expect(history).to.include('request-status-chip request-status--rejected');
      expect(history).to.include('{{t "requests.statusPending"}}');
      expect(history).to.include('{{t "requests.statusApproved"}}');
      expect(history).to.include('{{t "requests.statusRejected"}}');
    });
  });

  describe('compiled CSS matches SCSS scope + a11y contracts', function () {
    it('has .requests-page rules', function () {
      expect(css).to.match(/\.requests-page\b/);
    });
    it('scopes new tokens under .requests-page (light), not :root', function () {
      // The scoped token block must declare the surface tokens on the page root,
      // never on the global :root (which would leak across pages).
      expect(css).to.match(/\.requests-page\s*\{[^}]*--surface:/);
      expect(css).to.match(/\.requests-page\s*\{[^}]*--shadow-card:/);
      expect(css).to.match(/\.requests-page\s*\{[^}]*--radius-card:/);
    });
    it('declares dark tokens under [data-theme="dark"] .requests-page', function () {
      // dart-sass strips the quotes from the compiled selector ([data-theme=dark]), so
      // assert against the SCSS source (which keeps them), exactly like the Stage 8C test.
      const block = blockOf(scss, '[data-theme="dark"] .requests-page');
      expect(block).to.include('--surface:');
    });
    it('press feedback uses a :hover:active compound that wins over :hover', function () {
      // Same cascade lesson as 8B/8C: during a mouse press :hover is also active, so the
      // :hover:active compound (higher specificity than :hover alone) must carry the scale.
      expect(css).to.match(/\.requests-page[^{}]*:active[^{}]*,[^{}]*\.requests-page[^{}]*:hover:active[^{}]*\{[^}]*transform:\s*scale/);
    });
    it('reduced-motion neutralizes transform incl. the :hover:active compound', function () {
      expect(css).to.match(/prefers-reduced-motion[\s\S]*\.requests-page[\s\S]*transform:\s*none/);
      expect(css).to.match(/prefers-reduced-motion[\s\S]*:hover:active[\s\S]*transform:\s*none/);
    });
    it('has a prefers-contrast block', function () {
      expect(css).to.match(/prefers-contrast:\s*more/);
    });
    it('overrides the global mobile-card chrome with scoped tokens at max-width:768px', function () {
      // The reused global .mobile-card-table paints static light $surface-color/$border-color
      // and clips via overflow:hidden; the page must override surface/border/shadow via tokens
      // so dark-mode cards match the theme, and open the card so long content wraps.
      expect(css).to.match(/max-width:\s*768px\s*\)\s*\{[\s\S]*?\.requests-page[^{]*\.mobile-card-table > tbody > tr[^{]*\{[^}]*background:\s*var\(--surface\)/);
      expect(css).to.match(/max-width:\s*768px\s*\)\s*\{[\s\S]*?\.requests-page[^{]*\.mobile-card-table > tbody > tr[^{]*\{[^}]*border-color:\s*var\(--surface-border\)/);
      expect(css).to.match(/max-width:\s*768px\s*\)\s*\{[\s\S]*?\.requests-page[^{]*\.mobile-card-table > tbody > tr[^{]*\{[^}]*overflow:\s*visible/);
      // and the hover override (global .table-hover > tr:hover uses static light at higher spec)
      expect(css).to.match(/max-width:\s*768px\s*\)\s*\{[\s\S]*?\.requests-page[^{]*\.mobile-card-table\.table-hover > tbody > tr:hover[^{]*\{[^}]*background:\s*var\(--surface\)/);
    });
    it('lets mobile links wrap long content (white-space normal + overflow-wrap on the link)', function () {
      expect(css).to.match(/max-width:\s*768px\s*\)\s*\{[\s\S]*?\.requests-page[^{]*\.mobile-card-table td a[^{]*\{[^}]*white-space:\s*normal/);
      expect(css).to.match(/max-width:\s*768px\s*\)\s*\{[\s\S]*?\.requests-page[^{]*\.mobile-card-table td a[^{]*\{[^}]*overflow-wrap:\s*anywhere/);
    });
    it('styles the bulk action bar scoped to the requests page', function () {
      expect(css).to.match(/\.requests-page\.has-active-bulk-actions/);
    });
    it('styles the status chips scoped to the requests page', function () {
      expect(css).to.match(/\.requests-page[^{}]*\.request-status-chip/);
    });
    it('uses px (not rem) font-size in every .requests-page rule', function () {
      // Bootstrap sets html { font-size: 10px }, so rem math is off by a factor; the page
      // uses px throughout. Assert no rem font-size appears inside any .requests-page block.
      const re = /\.requests-page[^{}]*\{[^}]*font-size:\s*[\d.]+rem/g;
      expect(css.match(re) || [], 'rem font-size found inside .requests-page rules').to.have.lengthOf(0);
    });
  });
});
