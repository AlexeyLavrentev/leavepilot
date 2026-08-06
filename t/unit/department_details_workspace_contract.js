'use strict';

/* Stage 8G — static contract for the scoped Department Details workspace. */

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

describe('Department details workspace contract (Stage 8G)', function () {
  const shell = read('views/department_details.hbs');
  const form = read('views/partials/department_details/general.hbs');
  const modal = read('views/partials/department_details/supervisers_modal.hbs');
  const controller = read('public/js/global.js');
  const scss = read('scss/main.scss');
  const css = read('public/css/style.css');

  describe('page shell and wayfinding', function () {
    it('uses a scoped main and one page-heading h1', function () {
      expect(shell).to.include('<main id="main-content" class="department-details-page" tabindex="-1">');
      expect(shell).to.include('class="page-heading"');
      expect(shell.match(/<h1[\s>]/g) || []).to.have.lengthOf(1);
      expect(shell).to.include('{{t "departments.detailsTitle" name=department.name}}');
      expect(shell).to.include('{{t "departments.detailsLead"}}');
    });

    it('moves the breadcrumb to the shell and renders it once', function () {
      expect(shell).to.include('class="breadcrumb department-details-breadcrumb"');
      expect(shell).to.include('href="/settings/departments/" data-vpp-all-departments-link="1"');
      expect(shell).to.include('<li class="active" aria-current="page">{{ department.name }}</li>');
      expect(form).to.not.include('class="breadcrumb');
    });

    it('keeps both exact navigation destinations and marks General active', function () {
      expect(shell).to.include('href="/settings/departments/edit/{{department.id}}/"');
      expect(shell).to.include('href="/users/?department={{ department.id }}"');
      expect(shell).to.include('class="list-group-item selected-item" aria-current="page"');
      expect(shell).to.include('{{t "departments.generalDetails"}}');
      expect(shell).to.include('{{t "departments.employeesFromDepartment"}}');
    });
  });

  describe('destructive action and primary form contracts', function () {
    it('preserves the department deletion endpoint and hooks', function () {
      expect(shell).to.include('method="post" action="/settings/departments/delete/{{ department.id }}/"');
      expect(shell).to.include('name="_csrf"');
      expect(shell).to.include('id="remove_btn" type="submit" class="btn btn-danger single-click"');
      expect(shell).to.include('data-toggle="tooltip" data-placement="top"');
    });

    it('preserves the edit form endpoint and save hooks', function () {
      expect(form).to.include('method="POST" action="/settings/departments/edit/{{ department.id }}/" id="department_edit_form"');
      expect(form).to.include('id="save_changes_btn" type="submit" class="btn btn-success single-click"');
      expect(form).to.include('href="/settings/departments/">{{t "common.cancel"}}');
    });

    it('uses exactly one raised form surface without legacy nested admin card', function () {
      expect(form.match(/class="[^"]*surface[^"]*"/g) || []).to.have.lengthOf(1);
      expect(form).to.include('class="surface department-details-surface"');
      expect(form).to.not.include('admin-form-card');
    });
  });

  describe('protected department settings', function () {
    it('preserves name, manager and allowance fields', function () {
      expect(form).to.include('id="name" name="name" required value="{{department.name}}"');
      expect(form).to.include('name="boss_id" id="manager_id"');
      expect(form).to.include('href="/users/edit/{{department.bossId}}/"');
      expect(form).to.include('name="allowance" id="allowance_select"');
      expect(form).to.include('{{#each allowance_options}}');
    });

    it('preserves both policy checkbox names and states', function () {
      expect(form).to.include('id="use_bank_holidays_inp" name="include_public_holidays" type="checkbox"');
      expect(form).to.include('{{# if department.include_public_holidays}} checked="checked"');
      expect(form).to.include('id="is_accrued_allowance_inp" name="is_accrued_allowance" type="checkbox"');
      expect(form).to.include('{{# if department.is_accrued_allowance}} checked="checked"');
    });

    it('keeps the work-calendar feature gate and destination', function () {
      expect(form).to.include('{{#feature_enabled "work_calendars"}}');
      expect(form).to.include('name="work_calendar_id" id="work_calendar_id"');
      expect(form).to.include('{{#each company.work_calendars}}');
      expect(form).to.include('href="/settings/bankholidays/"');
    });

    it('preserves the secondary-supervisor trigger and removal submit contract', function () {
      expect(form).to.include('<h3 class="control-label">{{t "departments.secondarySupervisors"}}</h3>');
      expect(form).to.include('a href="#" class="btn btn-link"');
      expect(form).to.include('data-vpp-add-new-secondary-supervisor="1"');
      expect(form).to.include('data-target="#add_secondary_supervisers_modal"');
      expect(form).to.include('data-department_id="{{department.id}}"');
      expect(form).to.include('data-department_name="{{department.name}}"');
      expect(form).to.include('name="remove_supervisor_id" value="{{this.id}}"');
    });

    it('keeps the existing modal form and controller selectors', function () {
      expect(modal).to.include('id="add_secondary_supervisers_modal"');
      expect(modal).to.include('action="/settings/departments/edit/{{ department.id }}/"');
      expect(modal).to.include('name="do_add_supervisors" value="1"');
      expect(controller).to.include("$('#add_secondary_supervisers_modal').on('show.bs.modal'");
      expect(controller).to.include(".load('/settings/departments/available-supervisors/'+department_id+'/'");
    });
  });

  describe('scoped visual and accessibility contract', function () {
    it('declares light tokens only inside the scoped page root', function () {
      const page = blockOf(scss, '.department-details-page');
      expect(page).to.include('--department-surface:');
      expect(page).to.include('--department-accent-soft:');
      expect(scss).to.not.match(/:root\s*\{[^}]*--department-/);
    });

    it('declares dark tokens below the page-scoped dark selector', function () {
      const dark = blockOf(scss, '[data-theme="dark"] .department-details-page');
      expect(dark).to.include('--department-surface:');
      expect(dark).to.include('--department-muted:');
      expect(dark).to.include('--department-accent-soft:');
    });

    it('compiles one scoped surface and responsive two-column layout', function () {
      expect(css).to.match(/\.department-details-page\s+\.surface\s*\{/);
      expect(css).to.match(/\.department-details-page\s+\.department-details-layout\s*\{[^}]*grid-template-columns:/);
      expect(css).to.match(/@media \(max-width: 768px\)[\s\S]*\.department-details-page \.department-details-layout/);
    });

    it('provides 44px controls, actions, navigation and checkbox labels', function () {
      expect(css).to.match(/\.department-details-page\s+\.form-control\s*\{[^}]*min-height:\s*44px/);
      expect(css).to.match(/\.department-details-page\s+\.department-details-nav \.list-group-item\s*\{[^}]*min-height:\s*44px/);
      expect(css).to.match(/\.department-details-page\s+\.department-choice-label\s*\{[^}]*min-height:\s*44px/);
    });

    it('uses a hover-active press compound and neutralizes it under reduced motion', function () {
      expect(css).to.match(/\.department-details-page[^{}]*:active[^{}]*,[\s\S]*?\.department-details-page[^{}]*:hover:active[^{}]*\{[^}]*transform:\s*scale\(0\.98\)/);
      const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)', css.indexOf('.department-details-page')));
      expect(reduced).to.include('.department-details-page');
      expect(reduced).to.include(':hover:active');
      expect(reduced).to.match(/transform:\s*none/);
    });

    it('supports increased contrast and reduced transparency', function () {
      expect(css).to.match(/@media \(prefers-contrast: more\)[\s\S]*\.department-details-page/);
    });

    it('does not use rem typography inside the Stage 8G scope', function () {
      const rules = css.match(/\.department-details-page[^{}]*\{[^}]*\}/g) || [];
      for (const rule of rules) expect(rule).to.not.match(/font-size:\s*[\d.]+rem/);
    });

    it('does not introduce unscoped Bootstrap overrides in the Stage 8G block', function () {
      const stage = css.slice(css.indexOf('.department-details-page'));
      expect(stage).to.not.match(/\n\s*\.(?:btn|row|form-group|list-group-item|surface)\s*\{/);
    });
  });
});
