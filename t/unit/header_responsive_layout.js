'use strict';

const fs = require('fs');
const path = require('path');
const {expect} = require('chai');

const stylesheet = fs.readFileSync(
  path.join(__dirname, '..', '..', 'scss', 'main.scss'),
  'utf8'
);

const header = fs.readFileSync(
  path.join(__dirname, '..', '..', 'views', 'partials', 'header.hbs'),
  'utf8'
);

const script = fs.readFileSync(
  path.join(__dirname, '..', '..', 'public', 'js', 'global.js'),
  'utf8'
);

function blockBody(source, marker) {
  const markerIndex = source.indexOf(marker);
  expect(markerIndex, `missing ${marker}`).to.be.at.least(0);

  const openingBrace = source.indexOf('{', markerIndex + marker.length);
  expect(openingBrace, `missing opening brace for ${marker}`).to.be.at.least(0);

  let depth = 1;
  for (let index = openingBrace + 1; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(openingBrace + 1, index);
  }

  throw new Error(`missing closing brace for ${marker}`);
}

describe('Responsive application header', function() {
  it('keeps utility navigation on the primary row and shrinks the nav instead', function() {
    const intermediate = blockBody(
      stylesheet,
      '@media (min-width: 769px) and (max-width: 1719px)'
    );
    const collapse = blockBody(intermediate, '.navbar-default .navbar-collapse.collapse');
    const primary = blockBody(intermediate, '.navbar-default .primary-navigation');
    const utility = blockBody(intermediate, '.navbar-default .navbar-right');

    // Overlap is prevented by letting the primary track shrink and scroll, not
    // by dropping the utility cluster onto a second row: below 1720px that is
    // every ordinary laptop, and the bar arrived split on the default window.
    expect(collapse).to.match(/flex-wrap:\s*nowrap/);
    expect(primary).to.match(/flex:\s*1 1 auto/);
    expect(primary).to.match(/min-width:\s*0/);
    expect(primary).to.match(/overflow-x:\s*auto/);
    expect(utility).to.match(/flex:\s*0 0 auto/);
    expect(utility).to.match(/justify-content:\s*flex-end/);
  });

  it('restores the single-row layout only at the wide desktop breakpoint', function() {
    const compactDesktop = blockBody(stylesheet, '@media (min-width: 1360px)');
    const wide = blockBody(stylesheet, '@media (min-width: 1720px)');
    const container = blockBody(wide, '.navbar-default .container-fluid');
    const collapse = blockBody(wide, '.navbar-default .navbar-collapse.collapse');
    const navigation = blockBody(wide, '.navbar-default .navbar-nav');

    expect(compactDesktop).not.to.match(/flex-wrap:\s*nowrap/);
    expect(container).to.match(/flex-wrap:\s*nowrap/);
    expect(collapse).to.match(/flex-wrap:\s*nowrap/);
    expect(navigation).to.match(/flex-wrap:\s*nowrap/);
  });

  it('orders the shrink ladder so its tightest step is the one that applies', function() {
    const looser = stylesheet.indexOf('@media (min-width: 769px) and (max-width: 1599px)');
    const tight = stylesheet.indexOf('@media (min-width: 769px) and (max-width: 1399px)');

    expect(looser, 'missing the 13px desktop step').to.be.at.least(0);
    expect(tight, 'missing the tightest desktop step').to.be.at.least(0);

    /*
      Both steps match `.navbar-default .navbar-nav > li > a` with the same
      specificity, so whichever is written last is the one that applies. Written
      the other way round the tighter step is dead source, and the band it names
      measures 13px in a browser rather than the 12px it asks for.
    */
    expect(tight, 'the tighter step has to come last to survive the cascade')
      .to.be.above(looser);

    const tightBlock = blockBody(
      stylesheet,
      '@media (min-width: 769px) and (max-width: 1399px)'
    );

    expect(blockBody(tightBlock, '.navbar-default .navbar-nav > li > a'))
      .to.match(/font-size:\s*12px/);
    expect(blockBody(tightBlock, '.primary-navigation .nav-primary-icon'))
      .to.match(/display:\s*none/);
  });

  it('collapses what will not fit into a menu rather than off the edge', function() {
    const row = header.slice(
      header.indexOf('primary-navigation'),
      header.indexOf('navbar-nav navbar-right')
    );

    expect(row).to.include('data-nav-overflow');
    expect(row).to.include('nav-overflow-menu');

    // Empty and hidden in the markup: a page without JavaScript keeps the
    // scrolling row asserted above rather than gaining an empty menu.
    expect(row).to.match(/class="dropdown nav-overflow hidden"/);
    expect(row).to.match(/<ul class="dropdown-menu nav-overflow-menu" role="menu"><\/ul>/);

    // The menu sits ahead of the action button on the row, and the script
    // excludes that button from the candidates, so the primary action of every
    // page is never the thing that ends up hidden behind a dropdown.
    expect(row.indexOf('data-nav-overflow')).to.be.below(row.indexOf('book_time_off_btn'));
    expect(script).to.match(/\.not\('\.navbar-form'\)/);

    // A track that scrolls also clips, and this menu opens out of that track.
    expect(script).to.include('nav-overflow-managed');
    expect(blockBody(stylesheet, '.navbar-default .primary-navigation.nav-overflow-managed'))
      .to.match(/overflow:\s*visible/);

    // The row drops icons in the tight band, and the menu lives inside the row.
    expect(blockBody(stylesheet, '.primary-navigation .nav-overflow-menu .nav-primary-icon'))
      .to.match(/display:\s*inline-block/);
  });
});
