'use strict';

/* Stage 8H — static contract for Bank Holidays & Work Calendars. */

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf8');
}

function blockOf(source, selector) {
  const start = source.indexOf(selector);
  expect(start, 'expected selector ' + selector).to.be.greaterThan(-1);
  let depth = 0;
  let index = source.indexOf('{', start);
  const begin = index;
  for (; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(begin, index + 1);
}

describe('Bank Holidays workspace contract (Stage 8H)', function () {
  const view = read('views/bankHolidays.hbs');
  const modal = read('views/partials/add_new_bank_holiday_modal.hbs');
  const controller = read('public/js/bank_holidays.js');
  const route = read('lib/route/bankHolidays.js');
  const scss = read('scss/main.scss');
  const css = read('public/css/style.css');

  describe('page shell and calendar switching', function () {
    it('uses a scoped main and exactly one page-heading h1', function () {
      expect(view).to.include('<main id="main-content" class="bank-holidays-page" tabindex="-1">');
      expect(view).to.include('class="page-heading"');
      expect(view.match(/<h1[\s>]/g) || []).to.have.lengthOf(1);
      expect(view).to.include('{{t "bankHolidays.title"}}');
      expect(view).to.include('{{t "bankHolidays.publicHolidaysForYear" company=company.name year=yearCurrent}}');
      expect(view).to.include('{{t "bankHolidays.localDaysForYear" calendar=selectedWorkCalendar.name year=yearCurrent}}');
    });

    it('keeps common and work-calendar query contracts with one current destination', function () {
      expect(view).to.include('class="bank-holidays-calendar-switcher"');
      expect(view).to.include('href="?year={{yearCurrent}}&week_type={{weekType}}"');
      expect(view).to.include('href="?year={{../yearCurrent}}&work_calendar={{this.id}}"');
      expect(view).to.include('aria-current="page"');
      expect(view).to.include('{{#each workCalendars}}');
    });

    it('keeps work calendars behind the production feature gate', function () {
      expect(view.match(/{{#feature_enabled "work_calendars"}}/g) || []).to.have.lengthOf(3);
      expect(view).to.include('data-target="#add_work_calendar_modal"');
      expect(view).to.include('id="add_work_calendar_modal"');
      expect(view).to.include('action="/settings/bankholidays/calendars/"');
      expect(view).to.include('action="/settings/bankholidays/calendars/delete/{{selectedWorkCalendar.id}}/"');
    });

    it('preserves both year-navigation query branches', function () {
      expect(view).to.include('href="?year={{yearPrev}}{{#if workCalendarId}}&work_calendar={{workCalendarId}}{{else}}&week_type={{weekType}}{{/if}}"');
      expect(view).to.include('href="?year={{yearNext}}{{#if workCalendarId}}&work_calendar={{workCalendarId}}{{else}}&week_type={{weekType}}{{/if}}"');
    });
  });

  describe('calendar and editing contracts', function () {
    it('renders all supplied months with semantic table headers and existing cells', function () {
      expect(view).to.include('{{# each calendar}}');
      expect(view).to.include('class="calendar_month month_{{ this.month }}"');
      expect(view).to.include('<caption class="sr-only">{{this.month}}</caption>');
      expect(view).to.include('scope="colgroup"');
      expect(view.match(/scope="col"/g) || []).to.have.lengthOf.at.least(8);
      expect(view).to.include('{{> calendar_cell day = this}}');
    });

    it('preserves update and delete endpoints and hidden state', function () {
      expect(view).to.include('id="delete_bankholiday_form" method="post" action="/settings/bankholidays/delete/"');
      expect(view).to.include('id="update_bankholiday_form" method="post" action="/settings/bankholidays/?year={{yearCurrent}}"');
      expect(view.match(/name="work_calendar_id" value="{{workCalendarId}}"/g) || []).to.have.lengthOf(2);
      expect(view).to.include('name="year" value="{{yearCurrent}}" type="hidden"');
    });

    it('preserves every dynamic holiday field and datepicker hook', function () {
      expect(view).to.include('name="date__{{id}}" tom-test-hook="date__{{@index}}"');
      expect(view).to.include('data-date-autoclose="1" data-provide="datepicker"');
      expect(view).to.include('data-date-format="{{#with ../logged_user.company}}{{this.get_default_date_format_for_date_picker}}{{/with}}"');
      expect(view).to.include('name="name__{{id}}" tom-test-hook="name__{{@index}}"');
      expect(view).to.include('name="day_type__{{id}}"');
      expect(view).to.include('value="{{../dayTypeNonWorking}}"');
      expect(view).to.include('value="{{../dayTypeWorking}}"');
    });

    it('keeps the remove button and controller protocol unchanged', function () {
      expect(view).to.include('class="btn btn-default bankholiday-remove-btn" type="button" value="{{id}}"');
      expect(view).to.include('tom-test-hook="remove__{{@index}}"');
      expect(view).to.include('data-confirm-message="{{t "common.deleteNamedConfirm" name=name}}"');
      expect(controller).to.include("$('button.bankholiday-remove-btn').on('click', function(e)");
      expect(controller).to.include("$('#delete_bankholiday_form')");
      expect(controller).to.include("delete_form.attr('action', delete_form.attr('action') + $(this).attr('value') + '/')");
    });

    it('preserves add-holiday modal parameters and trigger identity', function () {
      expect(view).to.include('id="add_new_bank_holiday_btn"');
      expect(view).to.include("container_id='add_new_bank_holiday_modal'");
      expect(view).to.include("form_action='/settings/bankholidays/'");
      expect(view).to.include('startDateOfYearCurrent=startDateOfYearCurrent');
      expect(view).to.include('dayTypeNonWorking=dayTypeNonWorking');
      expect(view).to.include('dayTypeWorking=dayTypeWorking');
      expect(modal).to.include('id="{{container_id}}"');
      expect(modal).to.include('action="{{form_action}}?year={{yearCurrent}}"');
    });
  });

  describe('import and authorization boundaries', function () {
    it('keeps preview GET and apply POST contracts inside the feature gate', function () {
      expect(view).to.include('method="GET" action="/settings/bankholidays/" class="bank-holidays-import-controls"');
      expect(view).to.include('id="bankholiday_week_type" name="week_type"');
      expect(view).to.include('method="POST" action="/settings/bankholidays/import/?year={{yearCurrent}}"');
      expect(view).to.include('name="week_type" value="{{weekType}}"');
      expect(view).to.include('{{#unless importChangesCount}}disabled="disabled"{{/unless}}');
    });

    it('uses the established opt-in mobile-card convention for import preview rows', function () {
      expect(view).to.include('class="table-responsive mobile-card-table-container bank-holidays-import-table"');
      expect(view).to.include('class="table table-condensed mobile-card-table bank-holidays-preview-table"');
      expect(view.match(/<td data-label=/g) || []).to.have.lengthOf(3);
      expect(css).to.match(/\.bank-holidays-page \.bank-holidays-import-table\s*\{[^}]*overflow:\s*visible/);
      expect(css).to.match(/\.bank-holidays-page \.bank-holidays-preview-table > tbody > tr\s*\{[^}]*background:\s*var\(--bank-surface-raised\)/);
    });

    it('leaves all bank-holiday routes behind admin authorization', function () {
      const handlers = route.match(/router\.(?:get|post)\(/g) || [];
      expect(handlers.length).to.be.greaterThan(0);
      expect(route).to.include("router.all(/.*/, require('../middleware/ensure_user_is_admin'))");
    });
  });

  describe('scoped visual and accessibility contract', function () {
    it('declares light and dark tokens only below the page scope', function () {
      const page = blockOf(scss, '.bank-holidays-page');
      const dark = blockOf(scss, '[data-theme="dark"] .bank-holidays-page');
      expect(page).to.include('--bank-surface:');
      expect(page).to.include('--bank-accent-soft:');
      expect(dark).to.include('--bank-surface:');
      expect(dark).to.include('--bank-accent-edge:');
      expect(scss).to.not.match(/:root\s*\{[^}]*--bank-/);
    });

    it('compiles the two-column workspace and responsive month grids', function () {
      expect(css).to.match(/\.bank-holidays-page\s+\.bank-holidays-workspace\s*\{[^}]*grid-template-columns:/);
      expect(css).to.match(/\.bank-holidays-page\s+\.bank-holidays-month-grid\s*\{[^}]*repeat\(3,/);
      expect(css).to.match(/@media \(max-width: 520px\)[\s\S]*\.bank-holidays-page \.bank-holidays-month-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
    });

    it('provides 44px switching, year, form and action targets', function () {
      expect(css).to.match(/\.bank-holidays-page \.bank-holidays-calendar-switcher \.admin-tabs > li > a\s*\{[^}]*min-height:\s*44px/);
      expect(css).to.match(/\.bank-holidays-page \.bank-holidays-year-toolbar \.btn\s*\{[^}]*min-height:\s*44px/);
      expect(css).to.match(/\.bank-holidays-page \.form-control\s*\{[^}]*min-height:\s*44px/);
      expect(css).to.match(/\.bank-holidays-page \.bank-holiday-remove \.btn\s*\{[^}]*min-width:\s*44px/);
    });

    it('uses hover-active press feedback and neutralizes it under reduced motion', function () {
      expect(css).to.match(/\.bank-holidays-page[^{}]*:active[^{}]*,[\s\S]*?\.bank-holidays-page[^{}]*:hover:active[^{}]*\{[^}]*transform:\s*scale\(0\.98\)/);
      const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)', css.indexOf('.bank-holidays-page')));
      expect(reduced).to.include('.bank-holidays-page');
      expect(reduced).to.include(':hover:active');
      expect(reduced).to.match(/transform:\s*none/);
    });

    it('supports contrast and transparency preferences', function () {
      expect(css).to.match(/@media \(prefers-contrast: more\)[\s\S]*\.bank-holidays-page/);
    });

    it('uses px rather than rem typography throughout the page scope', function () {
      const rules = css.match(/\.bank-holidays-page[^{}]*\{[^}]*\}/g) || [];
      expect(rules.length).to.be.greaterThan(10);
      for (const rule of rules) expect(rule).to.not.match(/font-size:\s*[\d.]+rem/);
    });

    it('does not introduce unscoped framework overrides in the Stage 8H block', function () {
      const stage = css.slice(css.indexOf('.bank-holidays-page'));
      expect(stage).to.not.match(/\n\s*\.(?:btn|row|form-group|nav-tabs|surface|calendar_month)\s*\{/);
    });
  });
});
