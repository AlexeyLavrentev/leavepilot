'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf8');
}

describe('Employee onboarding workspace contract (Stage 8J)', function () {
  const addView = read('views/user_add.hbs');
  const importView = read('views/users_import.hbs');
  const routes = read('lib/route/users/index.js');
  const scss = read('scss/main.scss');
  const css = read('public/css/style.css');
  const locales = ['en', 'ru', 'uk', 'be', 'kk'].map(function (locale) {
    return JSON.parse(read('public/locales/' + locale + '/translation.json'));
  });

  function ruleBlocks(source, marker) {
    const blocks = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let match;
    while ((match = re.exec(source))) {
      if (match[1].indexOf(marker) > -1) blocks.push(match[0]);
    }
    return blocks;
  }

  describe('shared page hierarchy and wayfinding', function () {
    it('uses one scoped main and one page-heading h1 on both routes', function () {
      expect(addView).to.include('class="employee-onboarding-page employee-onboarding-single"');
      expect(importView).to.include('class="employee-onboarding-page employee-onboarding-import"');
      for (const view of [addView, importView]) {
        expect((view.match(/<main\b/g) || []).length).to.equal(1);
        expect((view.match(/<h1\b/g) || []).length).to.equal(1);
        expect(view).to.include('class="page-heading"');
        expect(view).to.include('class="page-heading-titles"');
        expect(view).to.include('class="page-heading-actions"');
        expect(view).to.include('class="breadcrumb employee-onboarding-breadcrumb"');
        expect(view).to.include('aria-current="page"');
      }
    });

    it('provides reciprocal single/import navigation with established IDs', function () {
      expect(addView).to.include('href="/users/import/" id="import_users_btn"');
      expect(importView).to.include('href="/users/add/" id="add_new_department"');
    });
  });

  describe('single employee protected contract', function () {
    it('preserves the POST endpoint, CSRF, IDs and all field names', function () {
      expect(addView).to.include('method="POST" action="/users/add/" id="add_new_user_form"');
      expect(addView).to.include('name="_csrf" value="{{csrf_token}}"');
      for (const name of ['name', 'lastname', 'email_address', 'department', 'admin', 'auto_approve', 'start_date', 'end_date', 'password_one', 'password_confirm']) {
        expect(addView).to.match(new RegExp('name="' + name + '"'));
      }
      for (const id of ['name_inp', 'lastname_inp', 'email_inp', 'select_inp', 'admin_inp', 'auto_approve_inp', 'start_date_inp', 'end_date_inp', 'password_inp', 'confirm_password_inp', 'add_new_user_btn']) {
        expect(addView).to.include('id="' + id + '"');
      }
    });

    it('preserves required, email, LDAP readonly and datepicker behavior', function () {
      expect(addView).to.match(/id="name_inp"[^>]*required/);
      expect(addView).to.match(/id="lastname_inp"[^>]*required/);
      expect(addView).to.match(/id="email_inp" type="email"[^>]*required/);
      expect(addView).to.match(/id="start_date_inp"[^>]*required[^>]*data-provide="datepicker"/);
      expect(addView).to.match(/id="end_date_inp"[^>]*data-provide="datepicker"/);
      expect((addView.match(/data-date-week-start="1"/g) || []).length).to.equal(2);
      expect(addView).to.include('{{#if company.ldap_auth_enabled}} readonly {{/if}}');
      expect(addView).to.include('{{# if company.ldap_auth_enabled}}readonly{{/if}}');
      expect(addView).to.include('href="/settings/company/authentication/"');
    });

    it('groups identity, employment and access without nesting raised surfaces', function () {
      expect((addView.match(/class="surface employee-onboarding-surface"/g) || []).length).to.equal(3);
      expect(addView).to.include('id="employee-identity-heading"');
      expect(addView).to.include('id="employee-employment-heading"');
      expect(addView).to.include('id="employee-access-heading"');
      expect(addView).to.not.include('admin-form-card');
    });
  });

  describe('CSV import protected contract', function () {
    it('preserves the sample download form exactly', function () {
      expect(importView).to.include('method="POST" action="/users/import-sample/" id="users_import_sample_form"');
      expect(importView).to.include('id="users_import_sample_btn"');
      expect(importView).to.include('name="_csrf" value="{{csrf_token}}"');
    });

    it('preserves multipart upload endpoint, input and submit IDs', function () {
      expect(importView).to.include('action="/users/import/" method="post" role="form" enctype="multipart/form-data"');
      expect(importView).to.include('id="users_input_inp" type="file" name="users_import"');
      expect(importView).to.include('accept=".csv,text/csv"');
      expect(importView).to.include('id="submit_users_btn" type="submit"');
      expect(importView).to.include('single-click');
    });

    it('uses a semantic ordered three-step sequence and labels the file input', function () {
      expect(importView).to.include('<ol class="employee-import-steps">');
      expect((importView.match(/<li class="employee-import-step">/g) || []).length).to.equal(3);
      expect(importView).to.include('<label for="users_input_inp">');
      expect(importView).to.include('aria-describedby="users_import_file_help"');
    });
  });

  describe('route and security boundary', function () {
    it('keeps every user route behind the existing admin middleware', function () {
      expect(routes).to.include("router.all(/.*/, require('../../middleware/ensure_user_is_admin'));");
    });

    it('keeps all three endpoints and import safety limits', function () {
      expect(routes).to.include("router.get('/add/'");
      expect(routes).to.include("router.post('/add/'");
      expect(routes).to.include("router.get('/import/'");
      expect(routes).to.include("router.post('/import/'");
      expect(routes).to.include("router.post('/import-sample/'");
      expect(routes).to.include('uploaded.size > 2097152');
      expect(routes).to.include('parsed_data.length > 201');
      expect(routes).to.include('authSecurity.tokensMatch');
    });
  });

  describe('localization contract', function () {
    it('adds every Stage 8J key to all five supported locales', function () {
      for (const locale of locales) {
        for (const key of ['identityTitle', 'employmentTitle', 'accessTitle']) {
          expect(locale.userAdd[key]).to.be.a('string').and.not.equal('');
        }
        for (const key of ['prepareFileTitle', 'uploadFileTitle', 'fileLabel', 'fileHelp']) {
          expect(locale.usersImport[key]).to.be.a('string').and.not.equal('');
        }
      }
    });
  });

  describe('scoped visual and accessibility contract', function () {
    it('declares light/dark tokens under the page scope and not :root', function () {
      expect(scss).to.match(/\.employee-onboarding-page\s*\{[^}]*--onboarding-surface:/);
      expect(scss).to.match(/\[data-theme="dark"\] \.employee-onboarding-page\s*\{[^}]*--onboarding-surface:/);
      const root = scss.slice(scss.indexOf(':root {'), scss.indexOf('}', scss.indexOf(':root {')) + 1);
      expect(root).to.not.include('--onboarding-surface');
    });

    it('compiles bounded surfaces, field grids, stepper and native file control', function () {
      expect(css).to.match(/\.employee-onboarding-page\s*\{[^}]*max-width:\s*1120px/);
      expect(css).to.match(/\.employee-onboarding-page \.employee-onboarding-fields\s*\{[^}]*grid-template-columns:\s*repeat\(2/);
      expect(css).to.match(/\.employee-onboarding-page \.employee-import-step\s*\{[^}]*grid-template-columns:\s*44px/);
      expect(css).to.include('::file-selector-button');
    });

    it('provides 44px inputs, actions, options and file controls', function () {
      expect(css).to.match(/\.employee-onboarding-page \.form-control\s*\{[^}]*min-height:\s*44px/);
      expect(css).to.match(/\.employee-onboarding-page \.employee-onboarding-option > label\s*\{[^}]*min-height:\s*44px/);
      expect(css).to.match(/\.employee-onboarding-page \.employee-onboarding-actions \.btn[^}]*\{[^}]*min-height:\s*44px/);
      expect(css).to.match(/input\[type=file\]\s*\{[^}]*min-height:\s*44px/);
    });

    it('collapses fields/actions to one column at 768px', function () {
      const mobile = css.slice(css.indexOf('@media (max-width: 768px)', css.indexOf('.employee-onboarding-page')));
      expect(mobile).to.include('.employee-onboarding-page .employee-onboarding-fields');
      expect(mobile).to.include('grid-template-columns: minmax(0, 1fr)');
      expect(mobile).to.include('.employee-onboarding-page .employee-import-upload-form');
    });

    it('supports press feedback and neutralizes compounds under reduced motion', function () {
      expect(css).to.match(/\.employee-onboarding-page[^{}]*:hover:active[^{}]*\{[^}]*transform:\s*scale\(0\.98\)/);
      const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)', css.indexOf('.employee-onboarding-page')));
      expect(reduced).to.include('.employee-onboarding-page');
      expect(reduced).to.include(':hover:active');
      expect(reduced).to.match(/transform:\s*none/);
    });

    it('supports increased contrast and reduced transparency', function () {
      expect(css).to.match(/@media \(prefers-contrast: more\)[\s\S]*\.employee-onboarding-page/);
    });

    it('uses px rather than rem typography throughout the page scope', function () {
      const blocks = ruleBlocks(css, '.employee-onboarding-page');
      expect(blocks.length).to.be.greaterThan(25);
      for (const block of blocks) expect(block).to.not.match(/font-size:\s*[\d.]+rem/);
    });

    it('does not introduce unscoped framework overrides', function () {
      const start = scss.indexOf('/* Stage 8J');
      const source = scss.slice(start, scss.indexOf('\n[data-theme="dark"] {', start));
      expect(source).to.not.match(/\n\s*\.(?:btn|row|form-group|surface|breadcrumb)\s*\{/);
    });
  });
});
