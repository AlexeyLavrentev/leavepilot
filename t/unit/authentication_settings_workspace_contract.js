'use strict';

/*
 * Stage 8L — Authentication Settings Workspace contract.
 *
 * The redesign is presentation-only. These checks pin the LDAP/OIDC/SAML
 * field names, feature gate, secret handling and existing provider controller
 * while requiring the new styles to remain scoped and accessible.
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

describe('Authentication Settings workspace contract (Stage 8L)', function () {
  const view = read('views/settings_company_authentication.hbs');
  const scss = read('scss/main.scss');
  const css = read('public/css/style.css');
  const controller = read('public/js/settings_authentication.js');
  const settingsAuth = read('lib/auth/settings.js');
  const settingsRoute = read('lib/route/settings.js');

  describe('page shell and form boundary', function () {
    it('uses one scoped main, one heading and one POST form', function () {
      expect(view).to.include('<main id="main-content" class="authentication-settings-page" tabindex="-1">');
      expect(view.match(/<h1[\s>]/g) || []).to.have.lengthOf(1);
      expect(view.match(/<form\b/g) || []).to.have.lengthOf(1);
      expect(view).to.include('class="authentication-settings-form" action="" method="post" id="authentication_settings_form"');
      expect(view).to.include('<input type="hidden" name="_csrf" value="{{csrf_token}}">');
    });

    it('groups LDAP, SSO and provider configuration into deliberate surfaces', function () {
      expect(view).to.match(/<section class="[^"]*authentication-settings-ldap[^"]*"/);
      expect(view).to.match(/<section class="[^"]*authentication-settings-sso[^"]*"/);
      expect(view).to.match(/<section class="[^"]*authentication-settings-provider[^"]*"/);
      expect(view).to.not.match(/\bpanel(?:-default|-heading|-body)?\b/);
      expect(view).to.not.match(/\bwell\b/);
    });

    it('keeps the existing SSO feature gate around every SSO surface', function () {
      const gated = view.slice(view.indexOf('{{#if sso_available}}', view.indexOf('</section>')));
      expect(gated).to.include('authentication-settings-sso');
      expect(gated).to.include('authentication-settings-provider');
      expect(gated).to.include('{{/if}}');
      expect(settingsAuth).to.include('sso_available : !!args.ssoAvailable');
    });
  });

  describe('protected LDAP contract', function () {
    it('preserves every LDAP identifier and persisted name', function () {
      const fields = {
        ldap_auth_enabled: 'ldap_auth_enabled',
        ldap_url: 'url',
        allow_unauthorized_cert: 'allow_unauthorized_cert',
        ldap_bindn: 'binddn',
        ldap_password: 'bindcredentials',
        ldap_search_base: 'searchbase',
        current_user_password: 'password_to_check',
      };
      for (const [id, name] of Object.entries(fields)) {
        expect(view).to.match(new RegExp('id="' + id + '"[^>]*name="' + name + '"'));
      }
    });

    it('keeps current-admin verification and certificate bypass explicit', function () {
      expect(view).to.include('type="password" aria-describedby="current_user_password_help"');
      expect(view).to.include('class="authentication-settings-security-warning authentication-settings-field-wide" role="note"');
      expect(view).to.include('{{t "ldapAuth.allowUnauthorizedCertHelp"}}');
      expect(settingsRoute).to.include('ldap_server.authenticate(req.user.email, ldapParameters.password_to_check');
    });
  });

  describe('protected OIDC and SAML contract', function () {
    it('preserves common SSO controls', function () {
      for (const field of [
        'sso_auth_enabled',
        'sso_auth_provider',
        'sso_login_alias',
        'sso_email_domains',
        'sso_auto_create_users',
      ]) {
        expect(view).to.include('id="' + field + '"');
        expect(view).to.include('name="' + field + '"');
      }
    });

    it('preserves every provider-specific field name', function () {
      for (const field of [
        'sso_issuer_url',
        'sso_client_id',
        'sso_client_secret',
        'sso_scope',
        'sso_email_claim',
        'sso_require_verified_email',
        'sso_entry_point',
        'sso_idp_cert',
        'sso_identifier_format',
        'sso_email_attribute',
        'sso_sp_entity_id',
      ]) {
        expect(view).to.include('id="' + field + '"');
        expect(view).to.include('name="' + field + '"');
      }
    });

    it('never renders a stored OIDC secret into the password input', function () {
      const secret = view.match(/<input[^>]*id="sso_client_secret"[^>]*>/);
      expect(secret).to.not.equal(null);
      expect(secret[0]).to.include('type="password"');
      expect(secret[0]).to.include('autocomplete="new-password"');
      expect(secret[0]).to.not.include('value=');
      expect(secret[0]).to.not.include('client_secret}}');
      expect(settingsRoute).to.include('if (!ssoParameters.sso_auth_config.client_secret)');
      expect(settingsRoute).to.include('ssoParameters.sso_auth_config.client_secret = existingSsoConfig.client_secret');
    });

    it('keeps both provider marker groups and the unchanged manual controller', function () {
      expect(view.match(/data-sso-provider-section="oidc"/g) || []).to.have.lengthOf(2);
      expect(view.match(/data-sso-provider-section="saml"/g) || []).to.have.lengthOf(2);
      expect(controller).to.include("$('#sso_auth_provider')");
      expect(controller).to.include("$('[data-sso-provider-section]')");
      expect(settingsAuth).to.include("res.locals.custom_java_script.push('/js/settings_authentication.js')");
    });

    it('keeps mutual exclusion enforced by the backend', function () {
      expect(settingsRoute).to.include('if (ldapParameters.ldap_auth_enabled && ssoParameters.sso_auth_enabled)');
      expect(view.match(/authConfig\.mutuallyExclusiveHelp/g) || []).to.have.lengthOf(2);
    });

    it('preserves the save control hook', function () {
      expect(view).to.include('<button id="submit_registration" type="submit" class="btn btn-success single-click">');
    });
  });

  describe('translation coverage', function () {
    it('provides both new safety messages in every supported locale', function () {
      for (const locale of ['en', 'ru', 'uk', 'be', 'kk']) {
        const translation = JSON.parse(read('public/locales/' + locale + '/translation.json'));
        expect(translation.authConfig.mutuallyExclusiveHelp, locale).to.be.a('string').and.not.empty;
        expect(translation.ldapAuth.allowUnauthorizedCertHelp, locale).to.be.a('string').and.not.empty;
      }
    });
  });

  describe('scoped visual and accessibility contract', function () {
    it('declares light and dark tokens only on the scoped page root', function () {
      expect(blockOf(scss, '.authentication-settings-page')).to.include('--authentication-surface:');
      expect(blockOf(scss, '[data-theme="dark"] .authentication-settings-page')).to.include('--authentication-warning-bg:');
      expect(scss).to.not.match(/:root\s*\{[^}]*--authentication-/);
    });

    it('compiles surfaces, two-column fields and mobile collapse', function () {
      expect(css).to.match(/\.authentication-settings-page\s+\.authentication-settings-section\s*\{/);
      expect(css).to.match(/\.authentication-settings-page\s+\.authentication-settings-fields\s*\{[^}]*grid-template-columns:\s*repeat\(2/);
      expect(css).to.match(/@media \(max-width: 768px\)[\s\S]*\.authentication-settings-page\s+\.authentication-settings-fields\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
    });

    it('provides 44px inputs, options and primary action', function () {
      expect(css).to.match(/\.authentication-settings-page\s+\.form-control\s*\{[^}]*min-height:\s*44px/);
      expect(css).to.match(/\.authentication-settings-page\s+\.authentication-settings-toggle-label\s*\{[^}]*min-height:\s*44px/);
      expect(css).to.match(/\.authentication-settings-page\s+\.authentication-settings-actions \.btn\s*\{[^}]*min-height:\s*44px/);
    });

    it('uses immediate press feedback and neutralizes its compound under reduced motion', function () {
      expect(css).to.match(/\.authentication-settings-page[^{}]*:active[^{}]*,[^{}]*\.authentication-settings-page[^{}]*:hover:active[^{}]*\{[^}]*transform:\s*scale\(0\.98\)/);
      const authenticationStage = css.slice(
        css.indexOf('.authentication-settings-page'),
        css.indexOf('/* Stage 8M: Reminder Schedules Workspace */')
      );
      const reduced = authenticationStage.slice(authenticationStage.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
      expect(reduced).to.include('.authentication-settings-page');
      expect(reduced).to.include(':hover:active');
      expect(reduced).to.match(/transform:\s*none/);
    });

    it('supports contrast, reduced transparency and safe wrapping', function () {
      const stage = css.slice(css.indexOf('.authentication-settings-page'));
      expect(stage).to.include('@media (prefers-reduced-transparency: reduce)');
      expect(stage).to.include('@media (prefers-contrast: more)');
      expect(stage).to.match(/overflow-wrap:\s*anywhere/);
      expect(stage).to.match(/word-break:\s*break-word/);
    });

    it('uses px typography and adds no unscoped Bootstrap overrides', function () {
      const stage = css.slice(css.indexOf('.authentication-settings-page'));
      const rules = stage.match(/\.authentication-settings-page[^{}]*\{[^}]*\}/g) || [];
      for (const rule of rules) expect(rule).to.not.match(/font-size:\s*[\d.]+rem/);
      expect(stage).to.not.match(/\n\.(?:btn|row|form-group|surface|form-control)\s*\{/);
    });
  });
});
