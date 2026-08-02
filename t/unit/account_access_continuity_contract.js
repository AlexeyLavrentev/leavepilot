'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf8');
}

describe('Account access continuity contract (Stage 8K)', function () {
  const views = {
    register: read('views/register.hbs'),
    sso: read('views/login_sso.hbs'),
    forgot: read('views/forgot_password.hbs'),
    reset: read('views/reset_password.hbs'),
  };
  const loginRoute = read('lib/route/login.js');
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

  describe('shared hierarchy and continuity', function () {
    it('uses the existing auth language with one scoped main and one h1 per page', function () {
      for (const view of Object.values(views)) {
        expect(view).to.include('class="auth-page account-access-page');
        expect(view).to.include('class="auth-layout account-access-layout');
        expect(view).to.include('class="auth-intro account-access-intro"');
        expect(view).to.include('class="auth-panel account-access-panel"');
        expect(view).to.include('class="auth-card');
        expect((view.match(/<main\b/g) || []).length).to.equal(1);
        expect((view.match(/<h1\b/g) || []).length).to.equal(1);
        expect(view).to.include('aria-labelledby="account-access-title"');
        expect(view).to.include('aria-labelledby="account-access-form-title"');
      }
    });

    it('keeps the existing login page outside the Stage 8K scope', function () {
      const login = read('views/login.hbs');
      expect(login).to.include('class="auth-page"');
      expect(login).to.not.include('account-access-page');
      expect(login).to.include('id="local_login_form"');
    });
  });

  describe('registration protected contract', function () {
    it('preserves endpoint, CSRF, IDs, names and submit control', function () {
      const view = views.register;
      expect(view).to.include('<form action="/register" method="post"');
      expect(view).to.include('name="_csrf" value="{{csrf_token}}"');
      for (const name of ['company_name', 'name', 'lastname', 'email', 'password', 'password_confirmed', 'country', 'timezone']) {
        expect(view).to.match(new RegExp('name="' + name + '"'));
      }
      for (const id of ['company_name_inp', 'name_inp', 'lastname_inp', 'email_inp', 'pass_inp', 'confirm_pass_inp', 'country_inp', 'timezone_inp', 'submit_registration']) {
        expect(view).to.include('id="' + id + '"');
      }
    });

    it('preserves native validation and autocomplete semantics', function () {
      const view = views.register;
      for (const id of ['company_name_inp', 'name_inp', 'lastname_inp', 'email_inp', 'pass_inp', 'confirm_pass_inp', 'country_inp', 'timezone_inp']) {
        expect(view).to.match(new RegExp('id="' + id + '"[^>]*required'));
      }
      for (const value of ['organization', 'given-name', 'family-name', 'email', 'new-password']) {
        expect(view).to.include('autocomplete="' + value + '"');
      }
      expect(view).to.include('{{#each countries}}');
      expect(view).to.include('{{#each timezones_available}}');
    });
  });

  describe('SSO protected contract', function () {
    it('preserves direct and discovery forms, conditionals and selector IDs', function () {
      const view = views.sso;
      expect(view).to.include('{{#if sso_login.direct_sso_available}}');
      expect(view).to.include('action="{{sso_login.direct_sso_url}}" method="get" id="sso_direct_form"');
      expect(view).to.include('id="submit_sso_direct"');
      expect(view).to.include('action="/login/sso" method="post" id="sso_discovery_form"');
      expect(view).to.include('name="_csrf" value="{{csrf_token}}"');
      expect(view).to.match(/id="sso_email_inp"[^>]*type="email"[^>]*name="email"[^>]*required/);
      expect(view).to.include('id="submit_sso_login"');
      expect(view).to.include('id="back_to_password_login"');
    });
  });

  describe('password recovery protected contract', function () {
    it('preserves forgot-password endpoint, SSO hint and email semantics', function () {
      const view = views.forgot;
      expect(view).to.include('{{#if sso_login.has_sso_companies }}');
      expect(view).to.include('{{#if features.sso_authentication}}');
      expect(view).to.include('<form action="/forgot-password/" method="post"');
      expect(view).to.include('name="_csrf" value="{{csrf_token}}"');
      expect(view).to.match(/id="email_inp"[^>]*type="email"[^>]*name="email"[^>]*required/);
      expect(view).to.include('id="submit_login"');
    });

    it('preserves reset endpoint, signed token and both password names', function () {
      const view = views.reset;
      expect(view).to.include('<form action="/reset-password/" method="post"');
      expect(view).to.include('name="_csrf" value="{{csrf_token}}"');
      expect(view).to.include('name="t" value="{{token}}"');
      expect(view).to.match(/id="password_inp"[^>]*name="password"[^>]*autocomplete="new-password"[^>]*required/);
      expect(view).to.match(/id="confirm_password_inp"[^>]*name="confirm_password"[^>]*autocomplete="new-password"[^>]*required/);
      expect(view).to.include('id="submit_login"');
    });

    it('keeps generic recovery handling and reset-token verification in the route', function () {
      expect(loginRoute).to.include("var success_msg = req.t('login.messages.forgotPasswordSent');");
      expect(loginRoute).to.include('.get_user_by_reset_password_token(token)');
      expect(loginRoute).to.include("req.t('login.messages.resetLinkUnknown')");
      expect(loginRoute).to.include("req.t('login.messages.resetPasswordMismatch')");
      expect(loginRoute).to.include('authSecurity.verifyCsrfToken');
    });
  });

  describe('localization contract', function () {
    it('provides recovery context in all five supported locales', function () {
      for (const locale of locales) {
        expect(locale.forgotPassword.subtitle).to.be.a('string').and.not.equal('');
        expect(locale.resetPassword.subtitle).to.be.a('string').and.not.equal('');
      }
    });
  });

  describe('scoped visual and accessibility contract', function () {
    it('declares light and dark account tokens without changing root tokens', function () {
      expect(scss).to.match(/\.account-access-page\s*\{[^}]*--account-surface:/);
      expect(scss).to.match(/\[data-theme="dark"\] \.account-access-page\s*\{[^}]*--account-surface:/);
      const root = scss.slice(scss.indexOf(':root {'), scss.indexOf('}', scss.indexOf(':root {')) + 1);
      expect(root).to.not.include('--account-surface');
    });

    it('compiles the wide registration grid and bounded card', function () {
      expect(css).to.match(/\.account-access-page \.account-access-layout-wide\s*\{[^}]*grid-template-columns:/);
      expect(css).to.match(/\.account-access-register \.auth-layout \.account-access-card\s*\{[^}]*width:\s*min\(100%, 760px\)/);
      expect(css).to.match(/\.account-access-page \.account-access-field-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2/);
    });

    it('provides 48px fields/actions and collapses registration at 768px', function () {
      expect(css).to.match(/\.account-access-page \.form-control[^}]*\{[^}]*min-height:\s*48px/);
      expect(css).to.match(/\.account-access-page \.auth-submit[^}]*\{[^}]*min-height:\s*48px/);
      const mobile = css.slice(css.lastIndexOf('@media (max-width: 768px)'));
      expect(mobile).to.include('.account-access-page .account-access-field-grid');
      expect(mobile).to.include('grid-template-columns: minmax(0, 1fr)');
      expect(mobile).to.include('min-height: 44px');
    });

    it('supports press feedback and neutralizes the compound under reduced motion', function () {
      expect(css).to.match(/\.account-access-page \.btn:hover:active[^{}]*\{[^}]*transform:\s*scale\(0\.98\)/);
      const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
      expect(reduced).to.include('.account-access-page .btn:hover:active');
      expect(reduced).to.match(/transform:\s*none/);
    });

    it('supports increased contrast and reduced transparency', function () {
      const stage = scss.slice(scss.indexOf('/* Stage 8K'));
      expect(stage).to.match(/@media \(prefers-contrast: more\)[\s\S]*\.account-access-page/);
      expect(stage).to.match(/@media \(prefers-reduced-transparency: reduce\)[\s\S]*\.account-access-page/);
    });

    it('keeps typography compatible with the Bootstrap 10px root', function () {
      const blocks = ruleBlocks(css, '.account-access-page');
      expect(blocks.length).to.be.greaterThan(25);
      for (const block of blocks) expect(block).to.not.match(/font-size:\s*[\d.]+rem/);
    });

    it('does not introduce unscoped framework overrides', function () {
      const stage = scss.slice(scss.indexOf('/* Stage 8K'));
      expect(stage).to.not.match(/\n\s*\.(?:btn|row|form-group|auth-card|auth-layout)\s*\{/);
    });
  });
});
