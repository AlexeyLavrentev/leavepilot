'use strict';

/*
 * Stage 8F — General Settings workspace contract (/settings/general/).
 *
 * The page is presentation-only: these checks protect the existing company,
 * schedule, carry-over, leave-type, backup and destructive-action contracts
 * while asserting that the redesign remains scoped and accessible.
 */

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

describe('General Settings workspace contract (Stage 8F)', function () {
  const view = read('views/general_settings.hbs');
  const scss = read('scss/main.scss');
  const css = read('public/css/style.css');
  const controller = read('public/js/settings_general.js');

  describe('page shell and information architecture', function () {
    it('uses a scoped main and the established page heading', function () {
      expect(view).to.include('<main id="main-content" class="general-settings-page" tabindex="-1">');
      expect(view).to.include('class="page-heading"');
      expect(view).to.include('{{t "generalSettings.subtitle"}}');
    });

    it('renders exactly one h1', function () {
      expect(view.match(/<h1[\s>]/g) || []).to.have.lengthOf(1);
    });

    it('renders the six deliberate workspace surfaces', function () {
      for (const className of [
        'general-settings-company',
        'general-settings-schedule',
        'general-settings-carry-over',
        'general-settings-leave-types',
        'general-settings-related',
        'general-settings-danger',
      ]) {
        expect(view).to.match(new RegExp('<section class="[^"]*' + className + '[^"]*surface'));
      }
    });

    it('removes the legacy panel presentation from the page', function () {
      expect(view).to.not.match(/\bpanel(?:-default|-danger|-heading|-body)?\b/);
      expect(view).to.not.match(/\bwell\b/);
    });
  });

  describe('company and schedule forms', function () {
    it('preserves the company form endpoint and fields', function () {
      expect(view).to.include('method="POST" action="/settings/company/" id="company_edit_form"');
      expect(view).to.include('name="_csrf"');
      expect(view).to.match(/id="input_company_name"[^>]*name="name" required/);
      for (const name of [
        'country',
        'date_format',
        'timezone',
        'carry_over',
        'share_all_absences',
        'is_team_view_hidden',
      ]) {
        expect(view).to.include('name="' + name + '"');
      }
    });

    it('preserves the company-wide schedule form and widget', function () {
      expect(view).to.include('method="POST" action="/settings/schedule" id="company_schedule_form"');
      expect(view).to.include('name="company_wide" value="1"');
      expect(view).to.include('{{> schedule_widget}}');
      expect(view).to.include('{{t "generalSettings.saveSchedule"}}');
    });

    it('preserves the carry-over endpoint without adding client-side behavior', function () {
      expect(view).to.include('id="calculate_carry_over_form" method="post" action="/settings/carryOverUnusedAllowance"');
      expect(view).to.not.match(/calculate_carry_over_form[^>]*onsubmit=/);
    });
  });

  describe('leave-type editor contracts', function () {
    it('preserves both forms and their endpoints', function () {
      expect(view).to.include('id="delete_leavetype_form" method="post" action="/settings/leavetypes/delete/"');
      expect(view).to.include('id="leave_type_edit_form" method="post" action="/settings/leavetypes/"');
    });

    it('preserves every persisted field name', function () {
      for (const field of [
        'first_record',
        'name__{{ this.id }}',
        'color__{{ this.id }}',
        'use_allowance__{{ this.id }}',
        'auto_approve__{{ this.id }}',
        'limit__{{ this.id }}',
        'deduction_unit__{{ this.id }}',
        'minimum_consecutive_days__{{ this.id }}',
      ]) {
        expect(view).to.include('name="' + field + '"');
      }
    });

    it('preserves controller and ordering hooks', function () {
      expect(view).to.include('data-tom-color-picker="1"');
      for (const hook of [
        'name_{{@index}}',
        'colour__{{@index}}',
        'allowance_{{@index}}',
        'approve_{{@index}}',
        'limit_{{@index}}',
        'deduction_unit_{{@index}}',
        'minimum_consecutive_days_{{@index}}',
        'remove_{{@index}}',
      ]) {
        expect(view).to.include('data-tom-leave-type-order="' + hook + '"');
      }
      expect(view).to.include('class="btn btn-default leavetype-remove-btn"');
      expect(view).to.include('data-confirm-message="{{t "common.deleteNamedConfirm" name=name}}"');
    });

    it('keeps contextual accessible names on dense controls', function () {
      expect(view).to.match(/<label class="input-group-addon">\s*<input type="radio"/);
      expect(view).to.match(/name="first_record"[^>]*aria-label="{{t "generalSettings\.leaveTypeNameHelp"}}: {{name}}"/);
      expect(view).to.match(/name="name__{{ this\.id }}"[^>]*aria-label="{{t "generalSettings\.leaveTypeNameLabel"}}: {{name}}"/);
      expect(view).to.match(/data-toggle="dropdown"[^>]*aria-label="{{t "generalSettings\.leaveTypeColorAction"}}: {{name}}"/);
      expect(view).to.match(/name="limit__{{ this\.id }}"[^>]*aria-label="{{t "generalSettings\.leaveTypeLimitLabel"}}: {{name}}"/);
      expect(view).to.match(/name="deduction_unit__{{ this\.id }}"[^>]*aria-label="{{t "generalSettings\.leaveTypeDeductionUnitLabel"}}: {{name}}"/);
      expect(view).to.match(/name="minimum_consecutive_days__{{ this\.id }}"[^>]*aria-label="{{t "generalSettings\.leaveTypeMinConsecutiveLabel"}}: {{name}}"/);
      expect(view).to.match(/leavetype-remove-btn[^>]*aria-label="{{t "common\.remove"}}: {{name}}"/);
    });

    it('preserves the add and remove modal triggers', function () {
      expect(view).to.include('id="add_new_leave_type_btn"');
      expect(view).to.include('data-target="#add_new_leave_type_modal"');
      expect(view).to.include("form_action='/settings/leavetypes/'");
      expect(view).to.include('data-target="#remove_company_modal"');
      expect(view).to.include("container_id='remove_company_modal'");
    });

    it('keeps the unchanged delete controller selector and confirmation behavior', function () {
      expect(controller).to.include("$('button.leavetype-remove-btn')");
      expect(controller).to.include("$('#delete_leavetype_form')");
      expect(controller).to.include('window.confirm(confirmationMessage)');
    });
  });

  describe('related and destructive actions', function () {
    it('preserves backup and bank-holiday links', function () {
      expect(view.match(/href="\/settings\/company\/backup\/"/g) || []).to.have.lengthOf(2);
      expect(view).to.include('href="/settings/bankholidays/"');
    });

    it('keeps company removal behind the existing modal', function () {
      expect(view).to.include('class="btn btn-danger"');
      expect(view).to.include('data-toggle="modal" data-target="#remove_company_modal"');
      expect(view).to.include('{{t "generalSettings.removeCompanyWarning"}}');
    });
  });

  describe('scoped visual and accessibility contract', function () {
    it('declares light tokens only on the scoped page root', function () {
      const pageBlock = blockOf(scss, '.general-settings-page');
      expect(pageBlock).to.include('--settings-surface:');
      expect(pageBlock).to.include('--settings-danger:');
      expect(scss).to.not.match(/:root\s*\{[^}]*--settings-/);
    });

    it('declares dark tokens under the page-scoped dark selector', function () {
      const darkBlock = blockOf(scss, '[data-theme="dark"] .general-settings-page');
      expect(darkBlock).to.include('--settings-surface:');
      expect(darkBlock).to.include('--settings-danger-surface:');
    });

    it('compiles the scoped root and shared surface treatment', function () {
      expect(css).to.match(/\.general-settings-page\s*\{[^}]*--settings-surface:/);
      expect(css).to.match(/\.general-settings-page\s+\.surface\s*\{/);
      expect(css).to.match(/\.general-settings-page\s+\.general-settings-danger\s*\{/);
    });

    it('uses a hover-active compound for immediate press feedback', function () {
      expect(css).to.match(/\.general-settings-page[^{}]*:active[^{}]*,[^{}]*\.general-settings-page[^{}]*:hover:active[^{}]*\{[^}]*transform:\s*scale\(0\.98\)/);
    });

    it('neutralizes all press compounds under reduced motion', function () {
      const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
      expect(reduced).to.include('.general-settings-page');
      expect(reduced).to.include(':hover:active');
      expect(reduced).to.match(/transform:\s*none/);
    });

    it('supports contrast, transparency and mobile preferences', function () {
      expect(css).to.match(/@media \(prefers-contrast: more\)[\s\S]*\.general-settings-page/);
      expect(css).to.match(/@media \(prefers-reduced-transparency: reduce\)[\s\S]*\.general-settings-page/);
      expect(css).to.match(/@media \(max-width: 768px\)[\s\S]*\.general-settings-page/);
    });

    it('provides 44px controls and a label-backed leave-type priority target', function () {
      expect(css).to.match(/\.general-settings-page\s+\.form-control\s*\{[^}]*min-height:\s*44px/);
      expect(css).to.match(/\.general-settings-page\s+\.leave-types-name-cell\s+\.input-group-addon\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/);
    });

    it('keeps Stage 8F typography in px rather than legacy-unsafe rem units', function () {
      const rules = css.match(/\.general-settings-page[^{}]*\{[^}]*\}/g) || [];
      for (const rule of rules) {
        expect(rule).to.not.match(/font-size:\s*[\d.]+rem/);
      }
    });

    it('does not add unscoped Bootstrap overrides in the Stage 8F SCSS block', function () {
      const compiledStage = css.slice(css.indexOf('.general-settings-page'));
      expect(compiledStage).to.not.match(/\n\.(?:btn|row|form-group|panel|surface)\s*\{/);
    });
  });
});
