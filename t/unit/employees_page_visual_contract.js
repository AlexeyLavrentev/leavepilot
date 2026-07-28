'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf8');
}

describe('Employees directory page visual contract (Stage 8A v2)', function () {
  const view = read('views/users.hbs');
  const scss = read('scss/main.scss');
  const css = read('public/css/style.css');

  // Helper: balanced-brace block of the first selector occurrence (handles #{...} interpolations).
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
    it('wraps the page in a scoped main.employees-page', function () {
      expect(view).to.match(/<main id="main-content" class="employees-page" tabindex="-1">/);
    });
    it('uses the existing page-heading with titles and actions', function () {
      expect(view).to.include('class="page-heading"');
      expect(view).to.include('class="page-heading-titles"');
      expect(view).to.include('class="page-heading-actions"');
      expect(view).to.match(/<h1>\{\{t "users\.title"\}\}<\/h1>/);
      expect(view).to.match(/<p class="lead">\{\{t "users\.companyStaff"/);
    });
    it('builds a workspace with aside (filters) and directory', function () {
      expect(view).to.include('class="employees-workspace"');
      expect(view).to.include('class="employees-aside"');
      expect(view).to.include('class="surface employees-filter"');
      expect(view).to.include('class="surface employees-directory"');
    });
    it('adds visible section headings using existing locale keys', function () {
      expect(view).to.match(/<h2[^>]*employees-filter-title[^>]*>\{\{t "users\.department"\}\}<\/h2>/);
      expect(view).to.match(/<h2[^>]*employees-filter-title[^>]*>\{\{t "users\.allGroups"\}\}<\/h2>/);
    });
  });

  describe('P2 fix: groups section renders unconditionally (legacy contract)', function () {
    it('does NOT wrap the groups section in {{#if company.groups.length}}', function () {
      expect(view).to.not.match(/\{\{#if company\.groups\.length\}\}/);
      // both all-departments blocks present (departments + groups)
      expect(view.match(/class="all-departments"/g)).to.have.lengthOf(2);
    });
  });

  describe('P1 fix: mobile table reuses established card classes (no overflow, sr-only thead)', function () {
    it('uses mobile-card-table-container wrapper, not data-table-scroll', function () {
      expect(view).to.include('mobile-card-table-container');
      expect(view).to.not.include('class="data-table-scroll"');
    });
    it('adds mobile-card-table class to the directory table', function () {
      expect(view).to.match(/<table[^>]*class="[^"]*mobile-card-table[^"]*"/);
    });
    it('keeps a semantic caption and thead with scope=col headers', function () {
      expect(view).to.match(/<caption class="sr-only">/);
      expect(view).to.match(/<th scope="col">/);
    });
    it('adds data-label to every data cell', function () {
      for (const key of ['users.name', 'users.department', 'users.isAdmin', 'users.availableAllowance', 'users.daysUsed']) {
        expect(view).to.include("data-label=\"{{t '" + key + "'}}\"");
      }
    });
  });

  describe('P2 fix: scoped tokens (not global :root)', function () {
    const newTokens = ['--surface:', '--surface-sunken:', '--surface-border:', '--shadow-card:', '--radius-card:', '--space-2:'];
    it('declares new tokens under .employees-page (light)', function () {
      const block = blockOf(scss, '.employees-page {');
      for (const t of newTokens) expect(block, 'expected ' + t + ' in .employees-page block').to.include(t);
    });
    it('declares dark tokens under [data-theme="dark"] .employees-page', function () {
      const block = blockOf(scss, '[data-theme="dark"] .employees-page');
      for (const t of newTokens) expect(block, 'expected ' + t + ' in dark .employees-page').to.include(t);
    });
    it('does NOT add the new tokens to the global :root block', function () {
      const root = blockOf(scss, ':root {');
      // the pre-existing --color-* tokens remain, but the new surface/shadow tokens must not
      expect(root).to.not.include('--surface:');
      expect(root).to.not.include('--shadow-card:');
    });
    it('compiles the scoped tokens into public/css/style.css', function () {
      for (const t of newTokens) expect(css).to.include(t);
    });
  });

  describe('P2 fix: page-scoped dark link-hover (not global)', function () {
    it('does NOT change the global dark --color-link-hover token', function () {
      const dark = blockOf(scss, '[data-theme="dark"] {');
      // unchanged: derives from the LIGHT $link-color (the latent bug stays global-scope; we only fix it on the page)
      expect(dark).to.match(/--color-link-hover:\s*#\{color\.adjust\(\$link-color/);
    });
    it('declares a page-scoped hover token under [data-theme="dark"] .employees-page', function () {
      const block = blockOf(scss, '[data-theme="dark"] .employees-page');
      expect(block).to.match(/--employees-link-hover:\s*#\{color\.adjust\(#8abcf5/);
    });
    it('applies the page-scoped hover only to .employees-page links in compiled CSS', function () {
      // dart-sass emits [data-theme=dark] (unquoted) per CSS spec; quote-optional matches repo convention.
      expect(css).to.match(/\[data-theme="?dark"?\]\s*\.employees-page[^{]*\{[^}]*--employees-link-hover/);
    });
  });

  describe('P2 fix: reduced-motion neutralizes transform too', function () {
    it('sets transform: none under prefers-reduced-motion for page controls', function () {
      expect(css).to.match(/prefers-reduced-motion:\s*reduce/);
      // find the reduced-motion block and confirm a transform:none rule exists within .employees-page scope
      expect(css).to.match(/\.employees-page[^{]*:active[^{]*\{[^}]*transform:\s*none/);
    });
  });

  describe('P2 fix: type sizes in px, not rem', function () {
    it('does not use rem font-size in ANY .employees-page rule (whole scope, not a prefix slice)', function () {
      // Bootstrap sets html{font-size:10px}, so any rem font-size in the page
      // scope computes to unreadable px. Scan EVERY rule whose selector is
      // scoped under .employees-page, not just the first N bytes.
      // A CSS rule is: <selector-list> { <declarations> }. We walk declarations
      // and reject any `font-size:<num>rem` whose preceding selector contained
      // .employees-page.
      const ruleRe = /([^{}]*?)\{([^{}]*)\}/g;
      let m;
      while ((m = ruleRe.exec(css)) !== null) {
        const selector = m[1];
        const body = m[2];
        if (/\.employees-page/.test(selector) && /font-size:\s*[0-9.]+rem/.test(body)) {
          expect.fail('found rem font-size in an .employees-page rule: ' + selector.trim() + ' { ' + body.trim() + ' }');
        }
      }
    });
  });

  describe('protected contract preserved', function () {
    it('keeps div.all-departments as direct container of <a> filter links in order', function () {
      expect(view).to.match(/<div class="all-departments">/);
      expect(view.match(/class="all-departments"/g)).to.have.lengthOf(2);
    });
    it('keeps row identity, department and numeric cell contracts', function () {
      expect(view).to.match(/<tr data-vpp-user-row="\{\{this\.user_id\}\}">/);
      expect(view).to.match(/<td class="user_department"/);
      expect(view).to.match(/<td class="vpp-days-remaining[^"]*"/);
      expect(view).to.match(/<td class="vpp-days-used[^"]*"/);
    });
    it('keeps the semantic table classes, caption and scroll region a11y', function () {
      expect(view).to.match(/<table[^>]*class="[^"]*table table-hover[^"]*"/);
      expect(view).to.match(/role="region" aria-label="\{\{t "users\.companyStaff"/);
      expect(view).to.include('tabindex="0"');
    });
    it('keeps aria-current (x4), selected-item, button ids and CSV inputs', function () {
      expect(view.match(/aria-current="true"/g)).to.have.lengthOf(4);
      expect(view).to.include('selected-item');
      expect(view).to.include('id="import_users_btn"');
      expect(view).to.include('id="add_new_department"');
      expect(view).to.include('name="department"');
      expect(view).to.include('name="group"');
      expect(view).to.include('name="as-csv"');
      expect(view).to.include('single-click');
    });
  });
});
