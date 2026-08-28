'use strict';

/*
 * Stage 8E — Employee Details workspace contract (/users/edit/:id/ + 4 tabs).
 *
 * Verifies the redesign scoped under .employee-details-page WITHOUT touching the locked
 * behavior contracts (those are exercised by crud_users, deactivate_and_activate_user,
 * edit_user_to_have_duplicated_email, schedule/user_specific, admin_view_of_user_calendar,
 * remaining_used_columns_match_user_details, and the Stage 8D requests contract). This file
 * asserts ONLY the new Stage 8E surface: scoped root, page heading, breadcrumb, four routes,
 * active state, the destructive form, the protected form hooks, the opt-in mobile_cards for
 * the absences history, and the compiled scoped CSS (tokens under .employee-details-page,
 * press cascade incl. :hover:active, reduced-motion neutralization, scoped mobile-card
 * chrome, px type).
 */

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf8');
}

// Extract the first balanced { ... } block following `selector` in `source`.
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

describe('Employee details workspace contract (Stage 8E)', function () {
  const shell = read('views/user_details.hbs');
  const general = read('views/partials/user_details/general.hbs');
  const schedule = read('views/partials/user_details/schedule.hbs');
  const calendar = read('views/partials/user_details/calendar.hbs');
  const absences = read('views/partials/user_details/absences.hbs');
  const breadcrumb = read('views/partials/user_details/breadcrumb.hbs');
  const scss = read('scss/main.scss');
  const css = read('public/css/style.css');

  describe('page shell and scoping', function () {
    it('wraps the page in a scoped main.employee-details-page', function () {
      expect(shell).to.match(/<main id="main-content" class="employee-details-page" tabindex="-1">/);
    });
    it('renders exactly one h1 (the employee name title)', function () {
      const h1s = shell.match(/<h1[\s>]/g) || [];
      expect(h1s.length).to.equal(1, 'expected exactly one h1 in the shell, got ' + h1s.length);
    });
    it('uses the page-heading pattern for the title', function () {
      expect(shell).to.include('class="page-heading"');
    });
    it('keeps the employee name title + deactivate badge inside the h1', function () {
      expect(shell).to.match(/<h1[^>]*class="[^"]*employee-page-title"/);
      expect(shell).to.include('{{t "userDetails.title" name=employee.name lastname=employee.lastname}}');
      expect(shell).to.include('class="label label-warning employee-status"');
      expect(shell).to.include('{{t "userDetails.deactivated"}}');
    });
    it('renders the breadcrumb once in the shell (not per-partial)', function () {
      expect(shell).to.include('{{> user_details/breadcrumb employee=employee }}');
      // The breadcrumb include must be removed from the four body partials now that it lives
      // in the shell (rendered exactly once across all four routes).
      expect(general).to.not.include('{{> user_details/breadcrumb');
      expect(schedule).to.not.include('{{> user_details/breadcrumb');
      expect(calendar).to.not.include('{{> user_details/breadcrumb');
      expect(absences).to.not.include('{{> user_details/breadcrumb');
    });
    it('keeps the breadcrumb contract (/users/ + employee full_name)', function () {
      expect(breadcrumb).to.include('<a href="/users/">');
      expect(breadcrumb).to.include('{{t "users.allEmployees"}}');
      expect(breadcrumb).to.include('{{this.full_name}}');
    });
  });

  describe('destructive (delete) form contract', function () {
    it('preserves the delete form hooks verbatim', function () {
      expect(shell).to.include('id="add_new_user_frm"');
      expect(shell).to.include('method="post"');
      expect(shell).to.include('action="/users/delete/{{employee.id}}/"');
      expect(shell).to.include('name="_csrf"');
      /*
        This asked for onsubmit="return confirm(" - the shape the guard used to
        have. An inline event handler is script, and script-src 'self' does not
        allow one, so the browser never installed it: the attribute sat in the
        markup looking like a guard while Delete deleted without asking. The
        message is data now, read by public/js/confirm_actions.js.
      */
      expect(shell).to.include('data-confirm-message="');
      expect(shell).to.not.match(/onsubmit\s*=/);
      expect(shell).to.include("{{t 'userDetails.deleteConfirm'");
      expect(shell).to.include('id="remove_btn"');
      expect(shell).to.include('type="submit"');
      expect(shell).to.include('single-click');
    });
    it('uses restrained danger styling (not a dominant red surface)', function () {
      // The delete action is wrapped so scoped CSS can make it restrained; btn-danger stays.
      expect(shell).to.match(/class="[^"]*employee-details-danger-action/);
    });
    it('wraps the delete form in a <div>, not a <span> (valid HTML model)', function () {
      // A <span> cannot contain flow content / a <form>; the wrapper must be a <div>.
      expect(shell).to.match(/<div class="[^"]*employee-details-danger-action/);
      expect(shell).to.not.match(/<span class="[^"]*employee-details-danger-action/);
    });
  });

  describe('four-tab navigation + routes', function () {
    it('renders a nav with the four exact routes', function () {
      expect(shell).to.include('aria-label="{{t "userDetails.sectionTitle"}}"');
      expect(shell).to.include('href="/users/edit/{{employee.id}}/"');
      expect(shell).to.include('href="/users/edit/{{employee.id}}/schedule/"');
      expect(shell).to.include('href="/users/edit/{{employee.id}}/calendar/"');
      expect(shell).to.include('href="/users/edit/{{employee.id}}/absences/"');
    });
    it('keeps the four labels', function () {
      expect(shell).to.include('{{t "userDetails.generalDetails"}}');
      expect(shell).to.include('{{t "userDetails.schedule"}}');
      expect(shell).to.include('{{t "calendar.calendarTitle"}}');
      expect(shell).to.include('{{t "userDetails.absences"}}');
    });
    it('toggles active state via selected-item + aria-current on each boolean', function () {
      for (const flag of ['show_main_tab', 'show_schedule_tab', 'show_calendar_tab', 'show_absence_tab']) {
        expect(shell).to.include('{{# if ' + flag + ' }} selected-item{{/if}}');
        expect(shell).to.include('{{# if ' + flag + ' }} aria-current="page"{{/if}}');
      }
    });
    it('keeps the four server-rendered partial branches', function () {
      expect(shell).to.include('{{# if show_absence_tab }}');
      expect(shell).to.include('{{> user_details/absences }}');
      expect(shell).to.include('{{else if show_schedule_tab}}');
      expect(shell).to.include('{{> user_details/schedule }}');
      expect(shell).to.include('{{else if show_calendar_tab}}');
      expect(shell).to.include('{{> user_details/calendar }}');
      expect(shell).to.include('{{> user_details/general }}');
    });
  });

  describe('protected form hooks — general tab', function () {
    it('keeps the edit form + every input contract', function () {
      expect(general).to.include('action="/users/edit/{{employee.id}}/"');
      expect(general).to.include('method="POST"');
      expect(general).to.include('name="_csrf"');
      expect(general).to.include('id="name_inp" name="name" required');
      expect(general).to.include('id="lastname_inp" name="lastname" required');
      expect(general).to.include('id="email_inp" type="email" name="email_address" required');
      expect(general).to.include('id="select_inp" name="department"');
      expect(general).to.include('id="admin_inp" name="admin" type="checkbox"');
      expect(general).to.include('id="auto_approve_inp" name="auto_approve" type="checkbox"');
      expect(general).to.include('id="start_date_inp"');
      expect(general).to.include('name="start_date" required');
      expect(general).to.include('id="end_date_inp"');
      expect(general).to.include('name="end_date"');
      expect(general).to.include('id="password_inp" type="password" name="password_one"');
      expect(general).to.include('id="confirm_password_inp" type="password" name="password_confirm"');
    });
    it('keeps the LDAP readonly contract (both spellings)', function () {
      expect(general).to.include('{{#if company.ldap_auth_enabled}} readonly {{/if}}');
      expect(general).to.include('{{# if company.ldap_auth_enabled}}readonly{{/if}}');
    });
    it('keeps aria-describedby wiring', function () {
      for (const id of ['email_help', 'department_help', 'auto_approve_help', 'start_date_help', 'end_date_help', 'password_inp_help']) {
        expect(general).to.include('aria-describedby="' + id + '"');
      }
    });
    it('keeps the datepicker data-* attributes', function () {
      expect(general).to.include('data-date-autoclose="1"');
      expect(general).to.include('data-provide="datepicker"');
      expect(general).to.include('data-date-week-start="1"');
    });
    it('keeps the links to Department / Authentication / Email Audit', function () {
      expect(general).to.include('href="/settings/departments/edit/{{employee.DepartmentId}}"');
      expect(general).to.include('href="/settings/company/authentication/"');
      expect(general).to.include('href="/audit/email/?user_id={{employee.id}}"');
    });
    it('keeps the Cancel link + Save button', function () {
      expect(general).to.include('href="/users/"');
      expect(general).to.include('{{t "common.cancel"}}');
      expect(general).to.include('id="save_changes_btn" type="submit" class="btn btn-success single-click"');
    });
    it('wraps the general content in a raised surface', function () {
      expect(general).to.match(/class="[^"]*employee-general-surface[^"]*surface/);
    });
  });

  describe('protected form hooks — schedule tab', function () {
    it('keeps the schedule form contract', function () {
      expect(schedule).to.include('action="/settings/schedule"');
      expect(schedule).to.include('id="company_schedule_form"');
      expect(schedule).to.include('name="_csrf"');
      expect(schedule).to.include('name="user_id" value="{{employee.id}}"');
      expect(schedule).to.include('{{> schedule_widget }}');
    });
    it('keeps the data-vpp hooks + submit buttons', function () {
      expect(schedule).to.include('data-vpp="declare-user-specific-schedule"');
      expect(schedule).to.include('data-vpp="link-to-company-schedule"');
      expect(schedule).to.include('name="revoke_user_specific_schedule"');
      expect(schedule).to.include('name="save_user_specific_schedule"');
    });
    it('wraps the schedule content in a raised surface', function () {
      expect(schedule).to.match(/class="[^"]*employee-schedule-surface[^"]*surface/);
    });
  });

  describe('protected hooks — calendar tab', function () {
    it('keeps the year navigation routes + query params', function () {
      expect(calendar).to.include('/users/edit/{{current_user.id}}/calendar/?year={{previous_year}}');
      expect(calendar).to.include('/users/edit/{{current_user.id}}/calendar/?year={{next_year}}{{#if show_full_year}}&show_full_year=1{{/if}}');
    });
    it('keeps the days-available allowance hook', function () {
      expect(calendar).to.include('data-tom-days-available-in-allowance');
    });
    it('keeps the allowance breakdown + leave-type statistics', function () {
      expect(calendar).to.include('{{> user_details/allowance_breakdown user_allowance = user_allowance }}');
      expect(calendar).to.include('leave_type_statistics');
    });
    it('keeps the calendar month table semantics + calendar_cell partial', function () {
      expect(calendar).to.include('class="calendar_month month_{{ this.month }}"');
      expect(calendar).to.include('<caption class="sr-only">{{this.month}}</caption>');
      expect(calendar).to.include('{{> calendar_cell day = this}}');
    });
    it('wraps the calendar content in a raised surface', function () {
      expect(calendar).to.match(/class="[^"]*employee-calendar-surface[^"]*surface/);
    });
  });

  describe('protected hooks — absences tab', function () {
    it('keeps the absences form contract + hidden identity fields', function () {
      expect(absences).to.include('action="/users/edit/{{employee.id}}/"');
      expect(absences).to.include('name="_csrf"');
      expect(absences).to.include('name="back_to_absences" value="1"');
      expect(absences).to.include('name="name" value="{{employee.name}}"');
      expect(absences).to.include('name="lastname" value="{{employee.lastname}}"');
      expect(absences).to.include('name="email_address" value="{{employee.email}}"');
      expect(absences).to.include('name="department" value="{{employee.DepartmentId}}"');
      expect(absences).to.include('name="start_date" value="{{as_date employee.start_date}}"');
      expect(absences).to.include('name="end_date" value="{{as_date employee.end_date}}"');
    });
    it('keeps both progressbars with full a11y contract', function () {
      // two role=progressbar segments with the aria + tabindex + popover dataset
      const pbCount = (absences.match(/role="progressbar"/g) || []).length;
      expect(pbCount).to.equal(2);
      expect(absences).to.include('aria-valuemin="0"');
      expect(absences).to.include('aria-valuemax="100"');
      expect(absences).to.include('aria-valuenow="{{ leave_statistics.used_so_far_percent }}"');
      expect(absences).to.include('aria-valuenow="{{ leave_statistics.remaining_percent }}"');
      expect(absences).to.include('aria-label="{{t "absences.usedSoFarLabel" days=leave_statistics.used_so_far}}"');
      expect(absences).to.include('aria-label="{{t "absences.remainingLabel" days=leave_statistics.remaining}}"');
      const tabCount = (absences.match(/tabindex="0"/g) || []).length;
      expect(tabCount).to.be.greaterThan(1);
    });
    it('keeps days_remaining_inp + carried_over + adjustment inputs', function () {
      expect(absences).to.include('id="days_remaining_inp" type="hidden"');
      expect(absences).to.include('id="carried_over_allowance_inp"');
      expect(absences).to.include('name="carried_over_allowance"');
      expect(absences).to.include('id="adjustment_inp"');
      expect(absences).to.include('name="adjustment"');
    });
    it('keeps the Save button', function () {
      expect(absences).to.include('id="save_changes_btn" type="submit" class="btn btn-success single-click"');
    });
    it('wraps the absences content in a raised surface', function () {
      expect(absences).to.match(/class="[^"]*employee-absence-surface[^"]*surface/);
    });
    it('opts the absence history into the mobile-card layout (mobile_cards=1)', function () {
      expect(absences).to.match(/user_requests_grouped[^}]*mobile_cards=1/);
    });
  });

  describe('compiled CSS matches SCSS scope + a11y contracts', function () {
    it('has .employee-details-page rules', function () {
      expect(css).to.match(/\.employee-details-page\b/);
    });
    it('scopes new tokens under .employee-details-page (light), not :root', function () {
      expect(css).to.match(/\.employee-details-page\s*\{[^}]*--surface:/);
      expect(css).to.match(/\.employee-details-page\s*\{[^}]*--shadow-card:/);
      expect(css).to.match(/\.employee-details-page\s*\{[^}]*--radius-card:/);
    });
    it('neutralises the legacy .admin-form-card chrome inside .surface (no card-in-card)', function () {
      // The .surface is the single raised wrapper; the legacy .admin-form-card carries its own
      // padding/border/radius/shadow and must be neutralised so only one raised surface remains.
      expect(css).to.match(/\.employee-details-page[^{}]*\.surface[^{}]*\.admin-form-card[^{}]*\{[^}]*padding:\s*0/);
      expect(css).to.match(/\.employee-details-page[^{}]*\.surface[^{}]*\.admin-form-card[^{}]*\{[^}]*background:\s*transparent/);
      expect(css).to.match(/\.employee-details-page[^{}]*\.surface[^{}]*\.admin-form-card[^{}]*\{[^}]*box-shadow:\s*none/);
    });
    it('scopes the mobile nav under .employee-details-page so it wins the cascade (2x2 grid)', function () {
      // Desktop compiles to .employee-details-page .employee-details-nav (0,2,0); the mobile
      // rule must carry the same prefix or it loses the cascade and the nav stays 1x4.
      expect(css).to.match(/max-width:\s*768px\s*\)\s*\{[\s\S]*?\.employee-details-page\s*\.employee-details-nav\s*\{[^}]*grid-template-columns:\s*repeat\(2/);
    });
    it('declares dark tokens under [data-theme="dark"] .employee-details-page', function () {
      // dart-sass strips quotes from the compiled selector; assert against the SCSS source.
      const block = blockOf(scss, '[data-theme="dark"] .employee-details-page');
      expect(block).to.include('--surface:');
    });
    it('press feedback uses a :hover:active compound that wins over :hover', function () {
      expect(css).to.match(/\.employee-details-page[^{}]*:active[^{}]*,[^{}]*\.employee-details-page[^{}]*:hover:active[^{}]*\{[^}]*transform:\s*scale/);
    });
    it('reduced-motion neutralizes transform incl. the :hover:active compound', function () {
      expect(css).to.match(/prefers-reduced-motion[\s\S]*\.employee-details-page[\s\S]*transform:\s*none/);
      expect(css).to.match(/prefers-reduced-motion[\s\S]*:hover:active[\s\S]*transform:\s*none/);
    });
    it('has a prefers-contrast block', function () {
      expect(css).to.match(/prefers-contrast:\s*more/);
    });
    it('overrides the global mobile-card chrome with scoped tokens at max-width:768px', function () {
      expect(css).to.match(/max-width:\s*768px\s*\)\s*\{[\s\S]*?\.employee-details-page[^{]*\.mobile-card-table > tbody > tr[^{]*\{[^}]*background:\s*var\(--surface\)/);
      expect(css).to.match(/max-width:\s*768px\s*\)\s*\{[\s\S]*?\.employee-details-page[^{]*\.mobile-card-table > tbody > tr[^{]*\{[^}]*overflow:\s*visible/);
    });
    it('lets mobile links wrap long content', function () {
      expect(css).to.match(/max-width:\s*768px\s*\)\s*\{[\s\S]*?\.employee-details-page[^{]*\.mobile-card-table td a[^{]*\{[^}]*overflow-wrap:\s*anywhere/);
    });
    it('uses px (not rem) font-size in every .employee-details-page rule', function () {
      const re = /\.employee-details-page[^{}]*\{[^}]*font-size:\s*[\d.]+rem/g;
      expect(css.match(re) || [], 'rem font-size found inside .employee-details-page rules').to.have.lengthOf(0);
    });
    it('styles the restrained danger action scoped to the page', function () {
      expect(css).to.match(/\.employee-details-page[^{}]*\.employee-details-danger-action/);
    });
  });
});
