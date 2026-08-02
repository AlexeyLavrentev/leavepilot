'use strict';

/*
 * Stage 8Q — shared admin/report workspace contract.
 *
 * Calendar feeds, bulk department editing, Team View and the employee
 * calendar share one scoped root (.workspace-page) instead of repeating a
 * token block each. These checks pin that the styles stay scoped, the views
 * opt in, and the accessibility modes (dark, contrast, reduced transparency,
 * reduced motion) are covered.
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

function mediaBlocks(source, marker) {
  const blocks = [];
  for (let at = source.indexOf(marker); at !== -1; at = source.indexOf(marker, at + 1)) {
    blocks.push(blockOf(source.slice(at), marker));
  }
  return blocks;
}

// view file -> the page-specific class it carries alongside .workspace-page
const WORKSPACE_VIEWS = {
  'views/feeds_list.hbs': 'feeds-page',
  'views/departments_bulk_update.hbs': 'departments-bulk-page',
  'views/team_view.hbs': 'team-view-page',
  'views/calendar.hbs': 'employee-calendar-page',
};

describe('Shared admin workspace contract (Stage 8Q)', function () {
  const scss = read('scss/main.scss');
  const css = read('public/css/style.css');

  describe('views opt into the scoped root', function () {
    for (const [file, pageClass] of Object.entries(WORKSPACE_VIEWS)) {
      it(`${file} carries .workspace-page and .${pageClass}`, function () {
        const view = read(file);
        const main = view.match(/<main[^>]*>/);
        expect(main, 'a <main> landmark').to.not.equal(null);
        expect(main[0]).to.contain('workspace-page');
        expect(main[0]).to.contain(pageClass);
        expect(view).to.contain('href="#main-content"');
      });
    }
  });

  it('declares its tokens only on the scoped root, never on :root', function () {
    expect(blockOf(scss, '.workspace-page {')).to.include('--workspace-surface:');
    expect(blockOf(scss, '[data-theme="dark"] .workspace-page')).to.include('--workspace-surface:');
    expect(scss).to.not.match(/:root\s*\{[^}]*--workspace-/);
  });

  it('compiles surfaces, tables and empty states', function () {
    expect(css).to.match(/\.workspace-page\s+\.workspace-surface\s*\{/);
    expect(css).to.match(/\.workspace-page\s+\.workspace-table\s*\{/);
    expect(css).to.match(/\.workspace-page\s+\.workspace-empty\s*\{/);
  });

  it('collapses workspace tables into cards on small screens', function () {
    const mobile = mediaBlocks(css, '@media (max-width: 768px)')
      .find(block => block.includes('.workspace-table.mobile-card-table'));
    expect(mobile, 'mobile card rules for workspace tables').to.be.a('string');
    expect(mobile).to.match(/content:\s*attr\(data-label\)/);
  });

  it('keeps press feedback immediate and drops it under reduced motion', function () {
    expect(css).to.match(/\.workspace-page[^{}]*\.btn:active\s*\{[^}]*transform:\s*scale\(0\.97\)/);
    const reduced = mediaBlocks(css, '@media (prefers-reduced-motion: reduce)')
      .find(block => block.includes('.workspace-page'));
    expect(reduced, 'reduced-motion block scoped to the workspace').to.be.a('string');
    expect(reduced).to.match(/transform:\s*none/);
  });

  it('supports increased contrast and reduced transparency', function () {
    const contrast = mediaBlocks(css, '@media (prefers-contrast: more)')
      .find(block => block.includes('.workspace-page'));
    expect(contrast, 'contrast block scoped to the workspace').to.be.a('string');

    const transparency = mediaBlocks(css, '@media (prefers-reduced-transparency: reduce)')
      .find(block => block.includes('.workspace-page'));
    expect(transparency, 'reduced-transparency block scoped to the workspace').to.be.a('string');
  });

  it('lets dense calendar grids opt out of the shared control sizing', function () {
    expect(css).to.match(/\.workspace-page:not\(\.workspace-page--calendar\)\s+\.btn\s*\{[^}]*min-height:\s*40px/);
    expect(css).to.match(/\.workspace-page:not\(\.workspace-page--calendar\)\s+\.form-control\s*\{[^}]*min-height:\s*40px/);
    expect(read('views/calendar.hbs')).to.contain('workspace-page--calendar');
    expect(read('views/team_view.hbs')).to.contain('workspace-page--calendar');
  });

  it('leaves no Bootstrap panel chrome on the redesigned pages', function () {
    const offenders = Object.keys(WORKSPACE_VIEWS).filter(file => {
      const view = read(file);
      return view.includes('panel panel-default')
        || view.includes('panel-heading')
        || view.includes('panel-body');
    });
    expect(offenders).to.deep.equal([]);
  });

  it('labels every workspace table cell for the mobile card layout', function () {
    const offenders = [];

    for (const file of Object.keys(WORKSPACE_VIEWS)) {
      const view = read(file);
      const tables = view.match(/<table\b[^>]*workspace-table[^>]*>[\s\S]*?<\/table>/g) || [];
      for (const table of tables) {
        const body = (table.match(/<tbody>[\s\S]*?<\/tbody>/) || [''])[0];
        const cells = body.match(/<t[dh]\b[^>]*>/g) || [];
        for (const cell of cells) {
          if (!cell.includes('data-label=') && !cell.includes('workspace-cell-actions')) {
            offenders.push(file + ': ' + cell);
          }
        }
      }
    }

    expect(offenders).to.deep.equal([]);
  });
});
