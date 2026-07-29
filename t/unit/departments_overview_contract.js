'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf8');
}

describe('Departments overview contract (Stage 8C)', function () {
  const view = read('views/departments_overview.hbs');
  const scss = read('scss/main.scss');
  const css = read('public/css/style.css');

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

  describe('page structure and scoping', function () {
    it('wraps the page in a scoped main.departments-page', function () {
      expect(view).to.match(/<main id="main-content" class="departments-page" tabindex="-1">/);
    });
    it('uses the existing page-heading with h1 + subtitle', function () {
      expect(view).to.include('class="page-heading"');
      expect(view).to.match(/<h1>\{\{t "departments\.title"\}\}<\/h1>/);
      expect(view).to.match(/<p class="lead">\{\{t "departments\.allDepartments"/);
    });
    it('keeps the add button and its modal target unchanged', function () {
      expect(view).to.include('id="add_new_department_btn"');
      expect(view).to.include('data-toggle="modal"');
      expect(view).to.include('data-target="#add_new_department_modal"');
    });
  });

  describe('single raised surface with semantic table', function () {
    it('places the catalog in one surface section', function () {
      expect(view).to.match(/<section class="departments-catalog surface"/);
    });
    it('uses the established mobile-card-table classes', function () {
      expect(view).to.include('mobile-card-table-container');
      expect(view).to.match(/<table[^>]*class="[^"]*mobile-card-table[^"]*"/);
    });
    it('keeps caption, region, tabindex', function () {
      expect(view).to.match(/<caption class="sr-only">/);
      expect(view).to.match(/role="region" aria-label="\{\{t "departments\.allDepartments"/);
      expect(view).to.include('tabindex="0"');
    });
    it('has 7 column headers with scope=col', function () {
      expect((view.match(/<th scope="col">/g) || []).length).to.equal(7);
    });
    it('adds a localized data-label to every data cell', function () {
      for (const key of ['common.name', 'departments.manager', 'departments.allowance', 'departments.numberEmployees', 'departments.publicHolidays', 'departments.accruedAllowance', 'departments.editDepartment']) {
        expect(view).to.include("data-label=\"{{t '" + key + "'}}\"");
      }
    });
  });

  describe('protected contracts preserved verbatim', function () {
    it('keeps the row readonly marker and the name anchor contract', function () {
      expect(view).to.match(/<tr data-vpp-department-list-mode="readonly">/);
      expect(view).to.match(/href="\/settings\/departments\/edit\/\{\{this\.id\}}\/" data-vpp-department-name=1/);
    });
    it('keeps manager href', function () {
      expect(view).to.match(/href="\/users\/edit\/\{\{this\.boss\.id\}}\/"/);
    });
    it('keeps employee-count href', function () {
      expect(view).to.match(/href="\/users\/\?department=\{\{ ?this\.id ?\}}"/);
    });
    it('has exactly two /settings/departments/edit/ hrefs per row (name + edit icon)', function () {
      // name anchor + edit anchor both point to edit page
      expect((view.match(/\/settings\/departments\/edit\/\{\{this\.id\}}\//g) || []).length).to.equal(2);
    });
    it('keeps the exact icon-edit anchor contract', function () {
      expect(view).to.match(/<a href="\/settings\/departments\/edit\/\{\{this\.id\}}\/" class="btn btn-link btn-xs pull-right" aria-label="\{\{t "departments\.editDepartment"\}\}: \{\{this\.name\}\}">/);
    });
    it('keeps the allowance_options caption lookup', function () {
      expect(view).to.include('{{#each ../allowance_options}}{{#if_equal this.value ../allowance}}{{caption}}{{/if_equal}}{{/each}}');
    });
    it('keeps the modal partial include with container_id and form_action', function () {
      expect(view).to.include("{{> add_new_department_modal");
      expect(view).to.include("container_id='add_new_department_modal'");
      expect(view).to.include("form_action='/settings/departments/'");
    });
  });

  describe('help buttons preserved on desktop + mobile policy-help block', function () {
    it('keeps both desktop help buttons with their aria-label/data-content/data-toggle/data-trigger', function () {
      expect(view).to.include('aria-label="{{t "departments.publicHolidays"}}"');
      expect(view).to.include('aria-label="{{t "departments.accruedAllowance"}}"');
      expect(view).to.include('data-content="{{t "departments.publicHolidaysHelp"}}"');
      expect(view).to.include('data-content="{{t "departments.accruedAllowanceHelp"}}"');
      expect((view.match(/data-toggle="popover"/g) || []).length).to.equal(2);
      expect((view.match(/data-trigger="focus hover"/g) || []).length).to.equal(2);
    });
    it('wraps the desktop help buttons in policy-help-desktop so they can be hidden on mobile', function () {
      expect((view.match(/class="policy-help-desktop"/g) || []).length).to.equal(2);
    });
    it('has a visible mobile-only policy-help block with both help texts', function () {
      expect(view).to.match(/<[^>]*class="[^"]*policy-help-mobile[^"]*"/);
      expect(view).to.include('{{t "departments.publicHolidaysHelp"}}');
      expect(view).to.include('{{t "departments.accruedAllowanceHelp"}}');
    });
  });

  describe('boolean cells render Yes/No text (not blank)', function () {
    it('renders common.no when public holidays / accrued are false', function () {
      // each boolean cell must have an {{else}} branch printing common.no
      expect(view).to.match(/\{\{# if this\.include_public_holidays \}\}\{\{t "common\.yes"\}\}\{\{else\}\}\{\{t "common\.no"\}\}\{\{\/if\}\}/);
      expect(view).to.match(/\{\{# if this\.is_accrued_allowance \}\}\{\{t "common\.yes"\}\}\{\{else\}\}\{\{t "common\.no"\}\}\{\{\/if\}\}/);
    });
  });

  describe('empty state inside the surface', function () {
    it('shows the no-departments message inside the surface, and renders the table only when departments exist', function () {
      expect(view).to.match(/\{\{#unless departments\.length\}\}[\s\S]*?departments-empty[\s\S]*?\{\{t "departments\.noDepartments"\}\}[\s\S]*?\{\{\/unless\}\}/);
      expect(view).to.match(/\{\{#if departments\.length\}\}[\s\S]*<table/);
    });
  });

  describe('compiled CSS matches SCSS scope + a11y contracts', function () {
    it('has .departments-page rules', function () {
      expect(css).to.include('.departments-page');
      expect(css).to.match(/\.departments-catalog/);
    });
    it('scopes new tokens under .departments-page (light), not :root', function () {
      const block = blockOf(scss, '.departments-page {');
      expect(block).to.include('--surface:');
      expect(block).to.include('--shadow-card:');
      const root = blockOf(scss, ':root {');
      expect(root).to.not.include('--departments-surface');
    });
    it('declares dark tokens under [data-theme="dark"] .departments-page', function () {
      const block = blockOf(scss, '[data-theme="dark"] .departments-page');
      expect(block).to.include('--surface:');
    });
    it('press feedback uses a :hover:active compound that wins over :hover', function () {
      expect(css).to.match(/\.departments-page[^{]*:hover:active[^{]*\{[^}]*scale\(0\.98\)/);
    });
    it('reduced-motion neutralizes transform incl. the :hover:active compound', function () {
      expect(css).to.match(/prefers-reduced-motion:\s*reduce/);
      expect(css).to.match(/\.departments-page[^{]*:active[^{]*\{[^}]*transform:\s*none/);
      expect(css).to.match(/prefers-reduced-motion:\s*reduce\s*\)\s*\{[\s\S]*?\.departments-page[^{]*:hover:active[^{]*\{[^}]*transform:\s*none/);
    });
    it('hides policy-help-desktop and shows policy-help-mobile at max-width:768px', function () {
      expect(css).to.match(/max-width:\s*768px/);
      expect(css).to.match(/\.departments-page[^{]*\.policy-help-desktop[^{]*\{[^}]*display:\s*none/);
      expect(css).to.match(/\.departments-page[^{]*\.policy-help-mobile[^{]*\{[^}]*display:\s*(?:block|flex)/);
    });
    it('defaults policy-help-mobile hidden and policy-help-desktop visible above 768px', function () {
      expect(css).to.match(/\.departments-page[^{]*\.policy-help-mobile[^{]*\{[^}]*display:\s*none/);
    });
    it('has a prefers-contrast block', function () {
      expect(css).to.match(/prefers-contrast:\s*more/);
    });
    it('enforces 44px tap targets on the action button and desktop help buttons', function () {
      // WCAG 2.5.5: these sit in the page/column header (not data rows), so a
      // min-height:44px is safe and must not be dropped.
      expect(css).to.match(/\.departments-page[^{]*\.page-heading-actions \.btn[^{]*\{[^}]*min-height:\s*44px/);
      expect(css).to.match(/\.departments-page[^{]*\.policy-help-desktop button[^{]*\{[^}]*min-height:\s*44px/);
    });
    it('uses px (not rem) font-size in every .departments-page rule', function () {
      const ruleRe = /([^{}]*?)\{([^{}]*)\}/g;
      let m;
      while ((m = ruleRe.exec(css)) !== null) {
        if (/\.departments-page/.test(m[1]) && /font-size:\s*[0-9.]+rem/.test(m[2])) {
          expect.fail('found rem font-size in a .departments-page rule: ' + m[1].trim());
        }
      }
    });
    it('wraps long text (overflow-wrap)', function () {
      expect(css).to.match(/\.departments-page[^}]*overflow-wrap:\s*anywhere/);
    });
  });
});
