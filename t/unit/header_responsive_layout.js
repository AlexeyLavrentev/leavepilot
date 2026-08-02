'use strict';

const fs = require('fs');
const path = require('path');
const {expect} = require('chai');

const stylesheet = fs.readFileSync(
  path.join(__dirname, '..', '..', 'scss', 'main.scss'),
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
});
