'use strict';

/* Stage 8N — Email Audit Workspace static contract. */

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

describe('Email Audit workspace contract (Stage 8N)', function () {
  const view = read('views/audit/emails.hbs');
  const route = read('lib/route/audit.js');
  const scss = read('scss/main.scss');
  const css = read('public/css/style.css');

  describe('page hierarchy and filter contract', function () {
    it('uses one scoped main, one page heading, and two deliberate surfaces', function () {
      expect(view).to.include('<main id="main-content" class="email-audit-page" tabindex="-1">');
      expect(view.match(/<h1[\s>]/g) || []).to.have.lengthOf(1);
      expect(view).to.include('class="page-heading"');
      expect(view.match(/class="surface/g) || []).to.have.lengthOf(2);
      expect(view).to.include('email-audit-filter-column');
      expect(view).to.include('email-audit-results');
    });

    it('preserves the GET filter endpoint and every field name', function () {
      expect(view).to.include('<form action="/audit/email/" method="GET"');
      expect(view).to.match(/id="start_date"[\s\S]*name="start_date"|name="start_date"[\s\S]*id="start_date"/);
      expect(view).to.match(/id="end_date"[\s\S]*name="end_date"|name="end_date"[\s\S]*id="end_date"/);
      expect(view).to.match(/id="employee" name="user_id"/);
      expect(view).to.include('href="/audit/email/" class="btn btn-default"');
      expect(view).to.include('class="btn btn-info single-click"');
    });

    it('preserves the datepicker and selected employee bindings', function () {
      expect(view.match(/data-provide="datepicker"/g) || []).to.have.lengthOf(2);
      expect(view.match(/data-date-autoclose="1"/g) || []).to.have.lengthOf(2);
      expect(view.match(/data-date-week-start="1"/g) || []).to.have.lengthOf(2);
      expect(view.match(/data-date-format=/g) || []).to.have.lengthOf(2);
      expect(view).to.include('{{# if_equal this.id ../filter.user_id }}selected="selected"{{/if_equal}}');
    });
  });

  describe('semantic log and disclosure contract', function () {
    it('keeps the exact table and legacy integration selectors', function () {
      expect(view).to.include('id="email_list"');
      expect(view).to.include('class="vpp-email-audit-entry-header"');
      expect(view).to.include('class="collapsed email-audit-subject"');
      expect(view).to.include('id="heading_{{ this.id }}"');
      expect(view).to.include('id="collapse_{{ this.id }}"');
    });

    it('keeps Bootstrap collapse relationships and initial ARIA state', function () {
      expect(view).to.include('data-toggle="collapse" data-parent="#email_list"');
      expect(view).to.include('href="#collapse_{{ this.id }}"');
      expect(view).to.include('aria-expanded="false" aria-controls="collapse_{{ this.id }}"');
      expect(view).to.include('class="collapse email-audit-detail-row"');
    });

    it('uses a semantic mobile-card table with localized cell labels', function () {
      expect(view).to.include('mobile-card-table-container email-audit-table-container');
      expect(view).to.include('table table-hover mobile-card-table email-audit-table');
      expect(view).to.include('role="region"');
      expect(view).to.include('tabindex="0"');
      expect(view.match(/<th scope="col">/g) || []).to.have.lengthOf(3);
      expect(view.match(/data-label="{{t "emailAudit\./g) || []).to.have.lengthOf(3);
    });

    it('preserves recipient filtering, mailto, timestamp, escaped body, and empty state', function () {
      expect(view).to.include('href="/audit/email/?user_id={{ this.user_id}}"');
      expect(view).to.include('href="mailto:{{this.email}}"');
      expect(view).to.include('{{as_datetime_from_timestamp this.created_at}}');
      expect(view).to.include('<pre class="email-audit-body">{{this.body_as_text}}</pre>');
      expect(view).to.not.include('{{{this.body_as_text}}}');
      expect(view).to.include('{{t "emailAudit.noEmails"}}');
    });

    it('keeps pager data and renders it only with audit entries', function () {
      expect(view).to.match(/{{# if audit_emails}}[\s\S]*{{> pager pager=pager }}[\s\S]*{{\/if}}/);
      expect(view).to.include('class="email-audit-pagination"');
    });
  });

  describe('authorization, privacy, and query boundaries', function () {
    it('keeps the entire router behind administrator authorization', function () {
      expect(route).to.include("router.all(/.*/, require('../middleware/ensure_user_is_admin'))");
    });

    it('keeps company scoping, inclusive dates, ordering, and pagination', function () {
      expect(route).to.include('company_id: req.user.companyId');
      expect(route).to.include("moment.utc(start_date).startOf('day').toDate()");
      expect(route).to.include("moment.utc(end_date).endOf('day').toDate()");
      expect(route).to.include("[ 'id', 'DESC']");
      expect(route).to.include('limit : items_per_page');
      expect(route).to.include('offset : items_per_page * (page - 1)');
    });

    it('keeps invalid filters away from database queries', function () {
      expect(route).to.include("req.session.flash_error(req.t('emailAudit.invalidFilters'))");
      expect(route).to.include("return res.redirect_with_session('/audit/email/')");
    });

    it('does not alter the Engram RESP2 deployment boundary', function () {
      expect(read('docker-compose.yml')).to.include('image: ghcr.io/alexeylavrentev/engram:0.2');
      expect(read('config/app.redis.json')).to.match(/"host"\s*:\s*"redis"/);
    });
  });

  describe('localization and scoped presentation', function () {
    it('provides the new results heading in all five locales', function () {
      for (const locale of ['en', 'ru', 'uk', 'be', 'kk']) {
        const translations = JSON.parse(read('public/locales/' + locale + '/translation.json'));
        expect(translations.emailAudit.resultsTitle, locale).to.be.a('string').and.not.be.empty;
      }
    });

    it('declares light and dark tokens only under the page scope', function () {
      expect(blockOf(scss, '.email-audit-page')).to.include('--email-audit-surface:');
      expect(blockOf(scss, '[data-theme="dark"] .email-audit-page')).to.include('--email-audit-focus:');
      expect(scss).to.not.match(/:root\s*\{[^}]*--email-audit-/);
    });

    it('compiles the two-column workspace, surfaces, and bounded body', function () {
      const stage = css.slice(css.indexOf('/* Stage 8N: Email Audit Workspace */'));
      expect(stage).to.match(/\.email-audit-page \.email-audit-workspace\s*\{[^}]*grid-template-columns:/);
      expect(stage).to.match(/\.email-audit-page \.surface\s*\{/);
      expect(stage).to.match(/\.email-audit-page \.email-audit-body\s*\{[^}]*max-height:\s*360px/);
      expect(stage).to.include('word-break: break-word');
    });

    it('provides 44px fields, actions, disclosures, and pager targets', function () {
      const stage = css.slice(css.indexOf('/* Stage 8N: Email Audit Workspace */'));
      expect(stage).to.match(/\.email-audit-page \.form-control,[\s\S]*min-height:\s*44px/);
      expect(stage).to.match(/\.email-audit-page \.audit-filter-actions \.btn\s*\{[^}]*min-height:\s*44px/);
      expect(stage).to.match(/\.email-audit-page \.user-link-cell a,[\s\S]*min-height:\s*44px/);
      expect(stage).to.match(/\.email-audit-page \.email-audit-pagination[\s\S]*min-height:\s*44px/);
    });

    it('keeps collapsed detail rows out of mobile layout and restores only .in', function () {
      const stage = css.slice(css.indexOf('/* Stage 8N: Email Audit Workspace */'));
      expect(stage).to.match(/@media \(max-width: 768px\)[\s\S]*\.email-audit-page \.email-audit-detail-row\.collapse:not\(\.in\)\s*\{[^}]*display:\s*none/);
      expect(stage).to.match(/\.email-audit-page \.email-audit-detail-row\.collapse\.in\s*\{[^}]*display:\s*block/);
      expect(stage).to.match(/\.email-audit-page \.email-audit-table > tbody > \.vpp-email-audit-entry-header[\s\S]*background:\s*var\(--email-audit-surface\)/);
    });

    it('uses press feedback and fully neutralizes it under reduced motion', function () {
      const stage = css.slice(css.indexOf('/* Stage 8N: Email Audit Workspace */'));
      expect(stage).to.match(/\.email-audit-page[^{}]*:hover:active[^{}]*\{[^}]*transform:\s*scale\(0\.985\)/);
      const reduced = stage.slice(stage.indexOf('@media (prefers-reduced-motion: reduce)'));
      expect(reduced).to.include('.email-audit-page .email-audit-subject:hover:active');
      expect(reduced).to.match(/transform:\s*none/);
    });

    it('supports contrast and transparency preferences with no unscoped overrides', function () {
      const stage = css.slice(css.indexOf('/* Stage 8N: Email Audit Workspace */'));
      expect(stage).to.include('@media (prefers-contrast: more)');
      expect(stage).to.not.match(/\n\.(?:btn|row|form-group|surface|table|collapse)\s*\{/);
    });

    it('uses px typography throughout the Stage 8N page scope', function () {
      const stage = css.slice(css.indexOf('/* Stage 8N: Email Audit Workspace */'));
      const rules = stage.match(/\.email-audit-page[^{}]*\{[^}]*\}/g) || [];
      expect(rules.length).to.be.greaterThan(35);
      for (const rule of rules) expect(rule).to.not.match(/font-size:\s*[\d.]+rem/);
    });
  });
});
