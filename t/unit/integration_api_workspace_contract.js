'use strict';

/*
 * Stage 8O — Integration API Security Workspace contract.
 *
 * This is a presentation and safety-hardening change. These checks pin the
 * admin boundary, feature registration, one-time plaintext handling and the
 * existing form hooks while keeping every new visual rule page-scoped.
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

describe('Integration API Security Workspace contract (Stage 8O)', function () {
  const view = read('views/settings_company_integration_api.hbs');
  const route = read('lib/route/settings.js');
  const controller = read('public/js/settings_integration_api.js');
  const premiumIntegration = read('t/integration/integration_api/enable_disable.js');
  const scss = read('scss/main.scss');
  const css = read('public/css/style.css');
  const features = read('lib/features.js');

  describe('page shell and protected form', function () {
    it('uses one scoped main, one heading, two surfaces and one POST form', function () {
      expect(view).to.include('<main id="main-content" class="integration-api-page" tabindex="-1">');
      expect(view.match(/<h1[\s>]/g) || []).to.have.lengthOf(1);
      expect(view.match(/<form\b/g) || []).to.have.lengthOf(1);
      expect(view).to.include('class="integration-api-form" action="" method="post" id="integration_api_settings_form"');
      expect(view).to.include('<input type="hidden" name="_csrf" value="{{csrf_token}}">');
      expect(view.match(/<section class="surface/g) || []).to.have.lengthOf(2);
    });

    it('preserves the enable, regenerate and save hooks exactly', function () {
      expect(view).to.match(/id="integration_api_enabled"[\s\S]*name="integration_api_enabled"/);
      expect(view).to.match(/id="regenerate_token_btn"[^>]*name="regenerate_token"[^>]*value="1"/);
      expect(view).to.include('id="save_settings_btn"');
      expect(view).to.include('id="token-value"');
      expect(view).to.include('id="token-value-hidden"');
      expect(route).to.include("router.post('/company/integration-api/'");
      expect(route).to.include('validator.toBoolean(req.body.integration_api_enabled)');
    });

    it('keeps every settings route behind the administrator middleware', function () {
      const guard = route.indexOf("router.all(/.*/, require('../middleware/ensure_user_is_admin'))");
      const get = route.indexOf("router.get('/company/integration-api/'");
      const post = route.indexOf("router.post('/company/integration-api/'");
      expect(guard).to.be.greaterThan(-1);
      expect(guard).to.be.lessThan(get);
      expect(guard).to.be.lessThan(post);
    });

    it('keeps Integration API disabled unless the external feature gate enables it', function () {
      expect(features).to.match(/integration_api\s*:\s*\{\s*defaultEnabled\s*:\s*false/);
      expect(route).not.to.include("features.setEnabled('integration_api'");
    });
  });

  describe('credential secrecy and deliberate rotation', function () {
    it('renders plaintext only from the one-time accessToken local', function () {
      expect(view).to.include('value="{{accessToken}}"');
      expect(view).not.to.include('company.integration_api_token');
      expect(view).not.to.include('company.integration_api_token_hash');
      expect(route).to.include('const accessToken = req.session.integration_api_token_once || null');
      expect(route).to.include('delete req.session.integration_api_token_once');
      expect(route).to.include('req.session.integration_api_token_once = result.token');
      expect(route).to.include("res.set('Cache-Control', 'no-store')");
    });

    it('marks the token readonly and private without placing it in logs or scripts', function () {
      expect(view).to.match(/class="form-control integration-api-token-value"[\s\S]*readonly[\s\S]*autocomplete="off"[\s\S]*spellcheck="false"/);
      expect(view).to.include('integrationApi.privateCredential');
      expect(controller).not.to.match(/console\.(?:log|info|warn|error)/);
      expect(controller).not.to.include('tokenInput.value);\n    console');
    });

    it('requires an explicit confirmation before token regeneration', function () {
      expect(view).to.include('aria-describedby="regenerate_token_warning"');
      expect(view).to.include('data-confirm-message="{{t "integrationApi.regenerateConfirm"}}"');
      expect(controller).to.include('window.confirm(message)');
      expect(controller).to.include('event.preventDefault()');
      expect(controller).to.match(/addEventListener\('click',[\s\S]*}, true\)/);
      expect(premiumIntegration.match(/confirm_dialog:\s*true/g) || []).to.have.lengthOf(2);
    });

    it('copies only from the one-time readonly field and announces the result', function () {
      expect(view).to.include('id="copy_token_status" role="status" aria-live="polite" aria-atomic="true"');
      expect(controller).to.include('navigator.clipboard.writeText(tokenInput.value)');
      expect(controller).to.include("document.execCommand('copy')");
      expect(controller).to.include('copyStatus.textContent = message');
    });
  });

  describe('translation coverage', function () {
    it('provides every new security message in all five locales', function () {
      const keys = [
        'statusEnabled', 'statusDisabled', 'securityNotice', 'enableHelp',
        'credentialHeading', 'privateCredential', 'copyToken', 'copied',
        'copyFailed', 'regenerateWarning', 'regenerateConfirm'
      ];
      for (const locale of ['en', 'ru', 'uk', 'be', 'kk']) {
        const translation = JSON.parse(read('public/locales/' + locale + '/translation.json'));
        for (const key of keys) {
          expect(translation.integrationApi[key], locale + ':' + key)
            .to.be.a('string').and.not.empty;
        }
      }
    });
  });

  describe('scoped visual and accessibility contract', function () {
    it('declares light and dark tokens only on the scoped page root', function () {
      expect(blockOf(scss, '.integration-api-page')).to.include('--integration-api-surface:');
      expect(blockOf(scss, '[data-theme="dark"] .integration-api-page')).to.include('--integration-api-warning-bg:');
      expect(scss).not.to.match(/:root\s*\{[^}]*--integration-api-/);
    });

    it('compiles a two-column workspace and a one-column mobile layout', function () {
      expect(css).to.match(/\.integration-api-page\s+\.integration-api-workspace\s*\{[^}]*grid-template-columns:/);
      expect(css).to.match(/@media \(max-width: 768px\)[\s\S]*\.integration-api-page\s+\.integration-api-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
    });

    it('provides 44px credential actions and toggle target', function () {
      expect(css).to.match(/\.integration-api-page\s+\.integration-api-toggle-label\s*\{[^}]*min-height:\s*44px/);
      expect(css).to.match(/\.integration-api-page\s+\.integration-api-actions \.btn,[\s\S]*min-height:\s*44px/);
      expect(css).to.match(/\.integration-api-page\s+\.integration-api-token-value\s*\{[^}]*min-height:\s*44px/);
    });

    it('neutralizes compound press transforms under reduced motion', function () {
      const start = css.indexOf('/* Stage 8O: Integration API Security Workspace */');
      const stage = css.slice(start, css.indexOf('/* Stage 8J', start));
      expect(stage).to.match(/\.integration-api-page[^{}]*:active[^{}]*,[^{}]*\.integration-api-page[^{}]*:hover:active[^{}]*\{[^}]*transform:\s*scale\(0\.98\)/);
      const reduced = stage.slice(stage.indexOf('@media (prefers-reduced-motion: reduce)'));
      expect(reduced).to.include(':hover:active');
      expect(reduced).to.match(/transform:\s*none/);
    });

    it('supports contrast, reduced transparency, focus and safe wrapping', function () {
      const start = css.indexOf('/* Stage 8O: Integration API Security Workspace */');
      const stage = css.slice(start, css.indexOf('/* Stage 8J', start));
      expect(stage).to.include('@media (prefers-reduced-transparency: reduce)');
      expect(stage).to.include('@media (prefers-contrast: more)');
      expect(stage).to.include(':focus-visible');
      expect(stage).to.match(/overflow-wrap:\s*anywhere/);
    });

    it('uses px typography and adds no unscoped framework overrides', function () {
      const start = css.indexOf('/* Stage 8O: Integration API Security Workspace */');
      const stage = css.slice(start, css.indexOf('/* Stage 8J', start));
      const rules = stage.match(/\.integration-api-page[^{}]*\{[^}]*\}/g) || [];
      for (const rule of rules) expect(rule).not.to.match(/font-size:\s*[\d.]+rem/);
      expect(stage).not.to.match(/\n\.(?:btn|row|form-group|surface|form-control)\s*\{/);
    });
  });
});
