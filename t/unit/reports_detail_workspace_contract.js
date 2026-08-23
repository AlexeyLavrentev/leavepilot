'use strict';

/* Stage 8I — static contract for both Reports detail workspaces. */

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf8');
}

function json(relativePath) {
  return JSON.parse(read(relativePath));
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

describe('Reports detail workspace contract (Stage 8I)', function () {
  const allowance = read('views/report/allowancebytime.hbs');
  const leaves = read('views/report/leaves.hbs');
  const route = read('lib/route/reports.js');
  const scss = read('scss/main.scss');
  const css = read('public/css/style.css');

  describe('shared page hierarchy and wayfinding', function () {
    it('uses one scoped main and one page-heading h1 on each report', function () {
      expect(allowance).to.include('class="report-detail-page report-allowance-page"');
      expect(leaves).to.include('class="report-detail-page report-leaves-page"');
      for (const view of [allowance, leaves]) {
        expect(view).to.include('class="page-heading"');
        expect(view.match(/<h1[\s>]/g) || []).to.have.lengthOf(1);
        expect(view).to.include('class="breadcrumb report-detail-breadcrumb"');
        expect(view).to.include('href="/reports/"');
        expect(view).to.include('aria-current="page"');
      }
    });

    it('uses one filter and one results surface per report', function () {
      for (const view of [allowance, leaves]) {
        expect(view.match(/class="surface report-filter-surface"/g) || []).to.have.lengthOf(1);
        expect(view.match(/class="surface report-results-surface"/g) || []).to.have.lengthOf(1);
        expect(view).to.include('class="report-section-heading"');
        expect(view).to.include('class="empty-state report-empty-state"');
      }
    });
  });

  describe('Allowance Usage protected contracts', function () {
    it('preserves the GET filter and exact query names', function () {
      expect(allowance).to.include('<form action="" method="GET" class="report-filter-form">');
      expect(allowance).to.include('id="department_id" name="department"');
      expect(allowance).to.include('<option value="">{{t "common.all"}}</option>');
      expect(allowance).to.include('name="start_date" class="form-control" id="start_date"');
      expect(allowance).to.include('name="end_date" class="form-control" id="end_date"');
      expect(allowance).to.include('name="as-csv" value="1"');
    });

    it('preserves month datepicker settings and current values', function () {
      expect(allowance.match(/data-provide="datepicker"/g) || []).to.have.lengthOf(2);
      expect(allowance.match(/data-date-format="yyyy-mm"/g) || []).to.have.lengthOf(2);
      expect(allowance.match(/data-date-min-view-mode="months"/g) || []).to.have.lengthOf(2);
      expect(allowance).to.include('value="{{start_date_str}}"');
      expect(allowance).to.include('value="{{end_date_str}}"');
    });

    it('preserves dynamic columns and report data hooks', function () {
      expect(allowance).to.include('{{# each users_and_leaves.0.statistics.leave_type_break_down.pretty_version}}');
      expect(allowance).to.include('data-vpp-user-list-row={{this.user.id}}');
      expect(allowance).to.include('data-vpp-leave-type-id="{{this.id}}"');
      expect(allowance).to.include('data-vpp-deducted-days="1"');
      expect(allowance).to.include('href="/users/edit/{{this.id}}/"');
      expect(allowance).to.include('same_month=same_month start_date=start_date_obj end_date=end_date_obj');
      expect(allowance).to.not.include('same_month=../same_month');
    });

    it('opts the semantic dynamic table into mobile cards', function () {
      expect(allowance).to.include('mobile-card-table-container report-results-table-container');
      expect(allowance).to.include('mobile-card-table report-results-table report-allowance-table');
      expect(allowance).to.include('<caption class="sr-only">');
      expect(allowance).to.include('<th scope="col">');
      expect(allowance).to.include('<tbody>');
      expect(allowance).to.include('<td data-label="{{this.name}}" data-vpp-leave-type-id="{{this.id}}">');
    });
  });

  describe('Leaves protected contracts', function () {
    it('preserves one GET form and every filter query name', function () {
      expect(leaves).to.include('<form action="" method="GET" class="report-detail-form">');
      expect(leaves).to.include('id="department_id" name="department"');
      expect(leaves).to.include('id="leave_type_id" name="leave_type"');
      expect(leaves.match(/<option value="">\{\{t "common\.all"\}\}<\/option>/g) || []).to.have.lengthOf(2);
      expect(leaves).to.include('name="start_date" class="form-control" id="start_date"');
      expect(leaves).to.include('name="end_date" class="form-control" id="end_date"');
      expect(leaves).to.include('name="as-csv" value="1"');
    });

    it('preserves day datepicker settings and current values', function () {
      expect(leaves.match(/data-provide="datepicker"/g) || []).to.have.lengthOf(2);
      expect(leaves.match(/data-date-format="yyyy-mm-dd"/g) || []).to.have.lengthOf(2);
      expect(leaves).to.include('value="{{startDateStr}}"');
      expect(leaves).to.include('value="{{endDateStr}}"');
    });

    it('keeps all eight server sort keys on desktop and visible mobile controls', function () {
      const keys = [
        'employeeFullName', 'departmentName', 'type', 'startDate',
        'endDate', 'status', 'createdAt', 'approver'
      ];
      expect(leaves).to.include('class="reports-mobile-sort"');
      expect(leaves).to.include('{{t "reportsLeaves.sortBy"}}');
      for (const key of keys) {
        expect(leaves.match(new RegExp('name="sort_by" type="submit" value="' + key + '"', 'g')) || [])
          .to.have.lengthOf(2);
      }
    });

    it('keeps the ten report columns and opts them into mobile cards', function () {
      expect(leaves).to.include('mobile-card-table report-results-table report-leaves-table user-requests-table');
      expect(leaves.match(/<th scope="col">/g) || []).to.have.lengthOf(10);
      expect(leaves.match(/<td data-label=/g) || []).to.have.lengthOf(10);
      expect(leaves).to.include('{{ this.employeeFullName }}');
      expect(leaves).to.include('{{ this.departmentName}}');
      expect(leaves).to.include('{{ this.deductedDays }}');
      expect(leaves).to.include('{{ this.approver }}');
      expect(leaves).to.include('{{ this.comment }}');
    });
  });

  describe('route and locale boundaries', function () {
    it('leaves both report routes behind the existing admin middleware', function () {
      expect(route).to.include("router.all(/.*/, require('../middleware/ensure_user_is_admin'))");
      expect(route).to.include("router.get('/allowancebytime/'");
      expect(route).to.include("router.get('/leaves/'");
      expect(route).to.include("req.query['as-csv']");
      expect(route).to.include("req.query.sort_by");
    });

    it('adds the mobile sort label to all five supported locales', function () {
      for (const locale of ['en', 'ru', 'uk', 'be', 'kk']) {
        expect(json('public/locales/' + locale + '/translation.json').reportsLeaves.sortBy)
          .to.be.a('string').and.not.be.empty;
      }
    });
  });

  describe('scoped visual and accessibility contract', function () {
    it('declares light and dark tokens only inside the report scope', function () {
      const page = blockOf(scss, '.report-detail-page');
      const dark = blockOf(scss, '[data-theme="dark"] .report-detail-page');
      expect(page).to.include('--report-surface:');
      expect(page).to.include('--report-accent-soft:');
      expect(dark).to.include('--report-surface:');
      expect(dark).to.include('--report-accent-edge:');
      expect(scss).to.not.match(/:root\s*\{[^}]*--report-/);
    });

    it('compiles bounded filters and responsive mobile-card results', function () {
      expect(css).to.match(/\.report-detail-page \.report-leaves-filter-grid\s*\{[^}]*grid-template-columns:/);
      expect(css).to.match(/\.report-detail-page \.report-results-table > tbody > tr\s*\{[^}]*background:\s*var\(--report-surface-raised\)/);
      expect(css).to.match(/@media \(max-width: 768px\)[\s\S]*\.report-detail-page \.report-date-range-fields\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
    });

    it('removes desktop sort controls from the mobile focus order and exposes mobile sort', function () {
      expect(css).to.match(/@media \(max-width: 768px\)[\s\S]*\.report-detail-page \.reports-desktop-sort-control\s*\{[^}]*display:\s*none/);
      expect(css).to.match(/@media \(max-width: 768px\)[\s\S]*\.report-detail-page \.reports-mobile-sort\s*\{[^}]*display:\s*block/);
    });

    it('provides 44px filters, actions and sorting targets', function () {
      expect(css).to.match(/\.report-detail-page \.form-control\s*\{[^}]*min-height:\s*44px/);
      expect(css).to.match(/\.report-detail-page \.report-filter-actions \.btn[^}]*\{[^}]*min-height:\s*44px/);
      expect(css).to.match(/\.report-detail-page \.reports-mobile-sort summary[^}]*\{[^}]*min-height:\s*44px/);
    });

    it('uses press feedback and neutralizes every compound under reduced motion', function () {
      expect(css).to.match(/\.report-detail-page[^{}]*:active[^{}]*,[\s\S]*?\.report-detail-page[^{}]*:hover:active[^{}]*\{[^}]*transform:\s*scale\(0\.98\)/);
      const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)', css.indexOf('.report-detail-page')));
      expect(reduced).to.include('.report-detail-page');
      expect(reduced).to.include(':hover:active');
      expect(reduced).to.match(/transform:\s*none/);
    });

    it('supports increased contrast and reduced transparency', function () {
      expect(css).to.match(/@media \(prefers-contrast: more\)[\s\S]*\.report-detail-page/);
    });

    it('uses px rather than rem typography throughout the report scope', function () {
      const rules = css.match(/\.report-detail-page[^{}]*\{[^}]*\}/g) || [];
      expect(rules.length).to.be.greaterThan(20);
      for (const rule of rules) expect(rule).to.not.match(/font-size:\s*[\d.]+rem/);
    });

    it('does not introduce unscoped framework overrides in Stage 8I', function () {
      const stage = css.slice(css.indexOf('.report-detail-page'));
      expect(stage).to.not.match(/\n\s*\.(?:btn|row|form-group|surface|table|breadcrumb)\s*\{/);
    });
  });
});
