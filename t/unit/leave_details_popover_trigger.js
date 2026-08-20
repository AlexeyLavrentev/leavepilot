'use strict';

const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');

describe('Interactive leave details popover trigger contract', function() {
  const read = relativePath => fs.readFileSync(
    path.join(__dirname, '../..', relativePath),
    'utf8'
  );

  it('uses semantic date buttons on both Requests surfaces', function() {
    const sources = [
      read('views/requests.hbs'),
      read('views/partials/user_requests.hbs'),
    ];

    sources.forEach(source => {
      expect(source).to.contain('<button type="button"');
      expect(source).to.contain('leave-details-summary-trigger interactive-leave-details-summary-trigger leave-details-date-trigger');
      expect(source).to.contain('<span class="sr-only">{{t "leave.leaveSummary"}}: </span>');
      expect(source).to.contain('{{> leave_dates leave=this}}');
      expect(source).to.contain('data-tom-leave-dates="1"');
      expect(source).not.to.match(/<a[^>]+class="leave-details-summary-trigger"/);
      expect(source).not.to.match(/href="#"/);
    });
  });

  it('hides the decorative leave-date arrow from assistive technology', function() {
    expect(read('views/partials/leave_dates.hbs'))
      .to.contain('fa-long-arrow-right" aria-hidden="true"');
  });

  it('passes the Team View employee into the calendar partial explicitly', function() {
    expect(read('views/partials/team_view_table.hbs'))
      .to.contain('{{> team_view_calendar_cell day=this employee=employeeRow.user}}');
    expect(read('views/partials/team_view_calendar_cell.hbs'))
      .to.contain("{{full_name employee}}, {{as_date_formatted day.dayjs 'D MMMM YYYY'}}");
  });

  it('uses semantic color tokens and minimum target sizes', function() {
    const scss = read('scss/main.scss');

    expect(scss).to.match(/\.leave-details-date-trigger\s*\{[^}]*min-height:\s*24px[^}]*color:\s*var\(--color-link\)/s);
    expect(scss).to.match(/\.leave-details-date-trigger:hover,[\s\S]*color:\s*var\(--color-link-hover\)/);
    expect(scss).to.match(/\.calendar-leave-details-trigger\s*\{[^}]*min-width:\s*24px[^}]*min-height:\s*24px/s);
  });

  describe('manual controller source contract', function() {
    let controller;

    before(function() {
      const source = read('public/js/global.js');
      const start = source.indexOf("var $interactiveLeaveTriggers = $('.interactive-leave-details-summary-trigger')");
      const end = source.indexOf('$(document).ready(function() {', start);

      expect(start).to.be.greaterThan(-1);
      expect(end).to.be.greaterThan(start);
      controller = source.slice(start, end);
    });

    it('initializes only the interactive marker with manual Bootstrap behavior', function() {
      expect(controller).to.contain("$('.interactive-leave-details-summary-trigger')");
      expect(controller).not.to.contain("$('.leave-details-summary-trigger')");
      expect(controller).to.contain("trigger: 'manual'");
      expect(controller).to.contain("container: 'body'");
      expect(controller).to.contain('placement: sidePopoverPlacement');
      expect(controller).to.contain("viewport: { selector: 'body', padding: 12 }");
      expect(read('public/js/global.js')).to.contain('availableSideSpace');
    });

    it('keeps leave-specific state, timers, and hoverable-tip handlers', function() {
      [
        'hovered', 'focused', 'pointerPinned', 'popoverHovered',
        'showTimer', 'hideTimer', 'currentXhr', 'content',
      ].forEach(field => expect(controller).to.contain(field + ':'));
      expect(controller).to.contain("data('leaveSummaryState'");
      expect(controller).to.contain('SHOW_DELAY_HOVER = 700');
      expect(controller).to.contain('HIDE_DELAY = 120');
      expect(controller).to.contain('mouseenter.leaveSummaryPopover');
      expect(controller).to.contain('mouseleave.leaveSummaryPopover');
    });

    it('binds one Escape and one outside-click document handler', function() {
      expect((controller.match(/keydown\.leaveSummaryPopover/g) || [])).to.have.length(1);
      expect((controller.match(/click\.leaveSummaryPopover/g) || [])).to.have.length(2);
      expect(controller).to.contain('if (!state || !state.pointerPinned) { return; }');
      expect(controller).to.contain('insidePopover');
    });

    it('uses live content and a fresh identity-guarded request per opening', function() {
      expect(controller).to.contain("'class': 'leave-summary-popover-content'");
      expect(controller).to.contain("'aria-live': 'polite'");
      expect(controller).to.contain("'aria-atomic': 'true'");
      expect(controller).to.contain("url: '/calendar/leave-summary/'");
      expect(controller).to.contain('state.currentXhr.abort()');
      expect(controller).to.contain('state.currentXhr !== xhr');
      expect(controller).to.contain("textStatus === 'abort'");
      expect(controller).to.contain('state.currentXhr === xhr');
    });

    it('maintains expanded state and distinguishes keyboard activation', function() {
      expect(controller).to.contain('shown.bs.popover.leaveSummaryPopover');
      expect(controller).to.contain("attr('aria-expanded', 'true')");
      expect(controller).to.contain('hidden.bs.popover.leaveSummaryPopover');
      expect(controller).to.contain("attr('aria-expanded', 'false')");
      expect(controller).to.contain('e.detail === 0');
    });

    it('does not reconstruct accessible names from surrounding DOM', function() {
      [
        'calendarLabel',
        'yearMatch',
        'dateSeparator',
        'teamLabel',
        "closest('.calendar_month')",
        "find('.team-view-employee-link",
        "attr('aria-label'",
      ].forEach(fragment => expect(controller).not.to.contain(fragment));
    });

    it('removes the legacy leave implementation', function() {
      const source = read('public/js/global.js');
      expect(source).not.to.contain('detailsInPopup');
      expect(source).not.to.contain('tmp-id-');
      expect(source).not.to.contain('$.now()');
    });
  });
});
