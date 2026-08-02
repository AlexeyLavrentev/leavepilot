'use strict';

/*
 * Stage 8P — Diagnostics Support Workspace contract.
 *
 * The redesign is presentation-only. It must preserve the sanitized snapshot,
 * administrator boundary and manual-download workflow without adding uploads.
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

describe('Diagnostics Support Workspace contract (Stage 8P)', function () {
  const view = read('views/settings_company_diagnostics.hbs');
  const route = read('lib/route/settings.js');
  const collector = read('lib/diagnostics.js');
  const docs = read('docs/docker-compose.md');
  const scss = read('scss/main.scss');
  const css = read('public/css/style.css');

  describe('page hierarchy and support workflow', function () {
    it('uses one scoped main, one h1 and four deliberate surfaces', function () {
      expect(view).to.include('<main id="main-content" class="diagnostics-page" tabindex="-1">');
      expect(view.match(/<h1[\s>]/g) || []).to.have.lengthOf(1);
      expect(view.match(/<section class="surface diagnostics-card/g) || []).to.have.lengthOf(4);
      expect(view).to.include('diagnostics-license');
      expect(view).to.include('diagnostics-premium');
      expect(view).to.include('diagnostics-features');
      expect(view).to.include('diagnostics-snapshot');
    });

    it('replaces legacy tables with semantic definitions and feature status', function () {
      expect(view).not.to.match(/<table\b/);
      expect(view).not.to.include('main-row_header');
      expect(view.match(/<dl class="diagnostics-detail-list">/g) || []).to.have.lengthOf(2);
      expect(view).to.include('<ul class="diagnostics-feature-list">');
      expect(view).to.include('{{#each enabledFeatureRows}}');
      expect(view).to.include('{{#if enabled}}{{t "diagnostics.statusEnabled"}}{{else}}{{t "diagnostics.statusDisabled"}}{{/if}}');
    });

    it('preserves every license and Premium field displayed by the legacy view', function () {
      for (const field of [
        'reason', 'customer', 'features', 'expires', 'licenseId', 'graceEndsAt',
        'maxActiveUsers', 'maintenanceUntil', 'revocationListExpiresAt'
      ]) {
        expect(view).to.include('diagnostics.license.' + field);
      }
      for (const field of ['loaded', 'required', 'moduleName']) {
        expect(view).to.include('diagnostics.edition.premium.' + field);
      }
      expect(view).to.include('diagnostics.edition.counts.routes');
      expect(view).to.include('diagnostics.edition.counts.migrationPaths');
    });

    it('keeps snapshot disclosure native and download-only', function () {
      expect(view).to.include('<details class="diagnostics-preview">');
      expect(view).to.include('<pre id="diagnostics_json_preview" tabindex="0"><code>{{diagnosticsJson}}</code></pre>');
      expect(view).to.include('href="/settings/company/diagnostics.json" download');
      expect(view).not.to.match(/<form\b/);
      expect(view).not.to.match(/(?:fetch|XMLHttpRequest|ajax|upload)/i);
      expect(view).to.include('diagnostics.privacyTitle');
      expect(view).to.include('diagnostics.supportHelp');
    });
  });

  describe('authorization and privacy boundaries', function () {
    it('keeps both routes behind the administrator middleware', function () {
      const guard = route.indexOf("router.all(/.*/, require('../middleware/ensure_user_is_admin'))");
      const page = route.indexOf("router.get('/company/diagnostics/'");
      const download = route.indexOf("router.get('/company/diagnostics.json'");
      expect(guard).to.be.greaterThan(-1);
      expect(page).to.be.greaterThan(guard);
      expect(download).to.be.greaterThan(guard);
    });

    it('keeps the exact JSON attachment contract and prevents caching', function () {
      expect(route).to.include("res.setHeader('Content-Disposition', 'attachment; filename=\"leavepilot-diagnostics.json\"')");
      expect(route).to.include("res.type('application/json')");
      const diagnosticsRoutes = route.slice(
        route.indexOf("router.get('/company/diagnostics/'"),
        route.indexOf("router.post('/company/integration-api/'")
      );
      expect(diagnosticsRoutes.match(/res\.set\('Cache-Control', 'no-store'\)/g) || [])
        .to.have.lengthOf(2);
    });

    it('retains recursive sensitive-key sanitization and no automatic transmission', function () {
      expect(collector).to.include('SENSITIVE_KEY_PATTERN');
      expect(collector).to.match(/signature\|secret\|password\|token\|private\.\?key\|public\.\?key\|authorization\|cookie/i);
      expect(collector).to.include('result[key] = sanitize(value[key])');
      expect(docs).to.include('никуда не отправляется автоматически');
      expect(docs).to.include('передача всегда выполняется вручную');
    });
  });

  describe('translation coverage', function () {
    it('provides all new status and disclosure labels in five locales', function () {
      const keys = [
        'generatedAt', 'statusValid', 'statusInvalid', 'statusLoaded',
        'statusNotLoaded', 'statusRequired', 'statusOptional', 'statusEnabled',
        'statusDisabled', 'featuresHelp', 'privacyTitle', 'preview'
      ];
      for (const locale of ['en', 'ru', 'uk', 'be', 'kk']) {
        const translation = JSON.parse(read('public/locales/' + locale + '/translation.json'));
        for (const key of keys) {
          expect(translation.diagnostics[key], locale + ':' + key)
            .to.be.a('string').and.not.empty;
        }
      }
    });
  });

  describe('scoped visual and accessibility contract', function () {
    it('declares light and dark tokens only on the page scope', function () {
      expect(blockOf(scss, '.diagnostics-page')).to.include('--diagnostics-surface:');
      expect(blockOf(scss, '[data-theme="dark"] .diagnostics-page')).to.include('--diagnostics-note-bg:');
      expect(scss).not.to.match(/:root\s*\{[^}]*--diagnostics-/);
    });

    it('compiles the two-column workspace and mobile collapse', function () {
      expect(css).to.match(/\.diagnostics-page\s+\.diagnostics-workspace\s*\{[^}]*grid-template-columns:\s*repeat\(2/);
      expect(css).to.match(/@media \(max-width: 768px\)[\s\S]*\.diagnostics-page\s+\.diagnostics-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
    });

    it('provides 44px download and native disclosure targets', function () {
      expect(css).to.match(/\.diagnostics-page\s+\.diagnostics-download\s*\{[^}]*min-height:\s*44px/);
      expect(css).to.match(/\.diagnostics-page\s+\.diagnostics-preview summary\s*\{[^}]*min-height:\s*44px/);
    });

    it('uses press feedback and neutralizes every compound under reduced motion', function () {
      const stage = css.slice(css.indexOf('/* Stage 8P: Diagnostics Support Workspace */'));
      expect(stage).to.match(/\.diagnostics-page[^{}]*:active[^{}]*,[\s\S]*:hover:active[\s\S]*\{[^}]*transform:\s*scale\(0\.985\)/);
      const reduced = stage.slice(stage.indexOf('@media (prefers-reduced-motion: reduce)'));
      expect(reduced).to.include('.diagnostics-preview summary:hover:active');
      expect(reduced).to.match(/transform:\s*none/);
    });

    it('supports contrast, transparency, focus and bounded JSON preview', function () {
      const stage = css.slice(css.indexOf('/* Stage 8P: Diagnostics Support Workspace */'));
      expect(stage).to.include('@media (prefers-reduced-transparency: reduce)');
      expect(stage).to.include('@media (prefers-contrast: more)');
      expect(stage).to.include(':focus-visible');
      expect(stage).to.match(/\.diagnostics-page\s+\.diagnostics-preview pre\s*\{[^}]*max-height:\s*420px[^}]*overflow:\s*auto/);
      expect(stage).to.match(/overflow-wrap:\s*anywhere/);
    });

    it('uses px typography and introduces no unscoped framework overrides', function () {
      const stage = css.slice(css.indexOf('/* Stage 8P: Diagnostics Support Workspace */'));
      const rules = stage.match(/\.diagnostics-page[^{}]*\{[^}]*\}/g) || [];
      for (const rule of rules) expect(rule).not.to.match(/font-size:\s*[\d.]+rem/);
      expect(stage).not.to.match(/\n\.(?:btn|row|surface|table|form-control)\s*\{/);
    });
  });
});
