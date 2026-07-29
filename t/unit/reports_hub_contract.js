'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf8');
}

describe('Reports Hub contract (Stage 8B)', function () {
  const view = read('views/report/index.hbs');
  const scss = read('scss/main.scss');
  const css = read('public/css/style.css');

  // balanced-brace block of the first selector occurrence (handles #{...} interpolations)
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
    it('wraps the page in a scoped main.reports-hub', function () {
      expect(view).to.match(/<main id="main-content" class="reports-hub" tabindex="-1">/);
    });
    it('uses the existing page-heading with h1 and subtitle', function () {
      expect(view).to.include('class="page-heading"');
      expect(view).to.match(/<h1>\{\{t "reportsPage\.title"\}\}<\/h1>/);
      expect(view).to.match(/<p class="lead">\{\{t "reportsPage\.subtitle"/);
    });
    it('keeps skip link, main tabindex, and flash partial', function () {
      expect(view).to.include('class="sr-only sr-only-focusable"');
      expect(view).to.include('tabindex="-1"');
      expect(view).to.include('{{> show_flash_messages }}');
    });
  });

  describe('exactly two full-card anchors with exact hrefs', function () {
    it('has exactly two <a class="report-card">', function () {
      expect(view.match(/<a class="report-card"/g)).to.have.lengthOf(2);
    });
    it('first card links to /reports/allowancebytime/ (trailing slash)', function () {
      expect(view).to.include('<a class="report-card" href="/reports/allowancebytime/">');
    });
    it('second card links to /reports/leaves/ (trailing slash)', function () {
      expect(view).to.include('<a class="report-card" href="/reports/leaves/">');
    });
    it('each card has an h2 and a description paragraph', function () {
      expect(view).to.match(/<h2>\{\{t "reportsPage\.allowanceByTime"\}\}<\/h2>/);
      expect(view).to.match(/<p class="report-card-desc">\{\{t "reportsPage\.allowanceByTimeDescription"\}\}<\/p>/);
      expect(view).to.match(/<h2>\{\{t "reportsPage\.employeesLeaves"\}\}<\/h2>/);
      expect(view).to.match(/<p class="report-card-desc">\{\{t "reportsPage\.employeesLeavesDescription"\}\}<\/p>/);
    });
    it('decorative icons are aria-hidden and use FA4 fa- classes', function () {
      const icons = view.match(/<(?:i|span) class="[^"]*fa fa-[^"]*" aria-hidden="true"><\/(?:i|span)>/g) || [];
      expect(icons.length).to.be.greaterThan(0);
    });
    it('contains no nested interactive element inside a card (no <button>, no nested <a>)', function () {
      // each report-card anchor must not wrap another interactive element
      const cardBlocks = view.match(/<a class="report-card"[\s\S]*?<\/a>/g) || [];
      expect(cardBlocks).to.have.lengthOf(2);
      cardBlocks.forEach(function (b) {
        expect(b).to.not.match(/<button/);
        // exactly one opening <a ...> per card block (no nested anchor)
        expect((b.match(/<a /g) || []).length).to.equal(1);
      });
    });
  });

  describe('legacy markup removed', function () {
    it('has no .well, .btn, .btn-link, .btn-lg on the page', function () {
      expect(view).to.not.match(/class="[^"]*well/);
      expect(view).to.not.match(/class="[^"]*\bbtn\b/);
      expect(view).to.not.match(/class="[^"]*\bbtn-link\b/);
      expect(view).to.not.match(/class="[^"]*\bbtn-lg\b/);
    });
  });

  describe('locale description keys exist in all 5 server locales', function () {
    const langs = ['en', 'ru', 'uk', 'be', 'kk'];
    for (const lg of langs) {
      it(lg + ' has both description keys', function () {
        const t = JSON.parse(read('public/locales/' + lg + '/translation.json'));
        expect(t.reportsPage, 'reportsPage namespace in ' + lg).to.be.an('object');
        expect(t.reportsPage.allowanceByTimeDescription, 'allowanceByTimeDescription in ' + lg).to.be.a('string').and.not.empty;
        expect(t.reportsPage.employeesLeavesDescription, 'employeesLeavesDescription in ' + lg).to.be.a('string').and.not.empty;
      });
    }
  });

  describe('compiled CSS matches SCSS scope + a11y contracts', function () {
    it('has .reports-hub rules', function () {
      expect(css).to.include('.reports-hub');
      expect(css).to.match(/\.reports-hub-grid/);
      expect(css).to.match(/\.report-card\b/);
    });
    it('scopes new tokens under .reports-hub (light), not :root', function () {
      const block = blockOf(scss, '.reports-hub {');
      expect(block).to.include('--surface:');
      expect(block).to.include('--shadow-card:');
      expect(block).to.include('--radius-card:');
      const root = blockOf(scss, ':root {');
      expect(root).to.not.include('--reports-hub'); // sanity
    });
    it('declares dark tokens under [data-theme="dark"] .reports-hub', function () {
      const block = blockOf(scss, '[data-theme="dark"] .reports-hub');
      expect(block).to.include('--surface:');
      expect(block).to.include('--shadow-card:');
    });
    it('reduced-motion neutralizes transform too', function () {
      expect(css).to.match(/prefers-reduced-motion:\s*reduce/);
      expect(css).to.match(/\.reports-hub[^{]*:active[^{]*\{[^}]*transform:\s*none/);
    });
    it('has a press feedback scale on report-card', function () {
      expect(css).to.match(/\.reports-hub[^{]*\.report-card:active[^{]*\{[^}]*scale\(0\.985\)/);
    });
    it('hover elevation is gated behind (hover:hover)', function () {
      expect(css).to.match(/\(hover:\s*hover\)/);
    });
    it('has a prefers-contrast block', function () {
      expect(css).to.match(/prefers-contrast:\s*more/);
    });
    it('collapses to a single column at max-width:768px', function () {
      expect(css).to.match(/max-width:\s*768px/);
      expect(css).to.match(/\.reports-hub-grid[^{]*\{[^}]*grid-template-columns:\s*1fr/);
    });
    it('uses px (not rem) font-size in every .reports-hub rule', function () {
      const ruleRe = /([^{}]*?)\{([^{}]*)\}/g;
      let m;
      while ((m = ruleRe.exec(css)) !== null) {
        if (/\.reports-hub/.test(m[1]) && /font-size:\s*[0-9.]+rem/.test(m[2])) {
          expect.fail('found rem font-size in a .reports-hub rule: ' + m[1].trim());
        }
      }
    });
    it('wraps long text (overflow-wrap) and prevents overflow', function () {
      expect(css).to.match(/\.reports-hub[^}]*overflow-wrap:\s*anywhere/);
    });
  });
});
