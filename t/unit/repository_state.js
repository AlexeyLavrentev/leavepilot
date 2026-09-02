'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const { expect } = require('chai');

const ROOT = path.join(__dirname, '..', '..');

const git = args => execFileSync('git', args, {
  cwd: ROOT,
  encoding: 'utf8',
});

describe('repository state', () => {
  it('keeps runtime license state out of git while preserving its exact root ignore', () => {
    const tracked = git(['ls-files', '--', 'data/license.json']);
    const ignored = git(['check-ignore', '-v', '--no-index', 'data/license.json']);

    expect(tracked).to.equal('');
    expect(ignored).to.match(/\.gitignore:\d+:\/data\/license\.json\tdata\/license\.json/);
  });

  it('keeps verification output ignored by its exact root rule', () => {
    const ignored = git(['check-ignore', '-v', '--no-index', '.artifacts/verify/simulated-evidence.json']);

    expect(ignored).to.match(/\.gitignore:\d+:\/\.artifacts\/verify\/\t\.artifacts\/verify\/simulated-evidence\.json/);
  });

  it('keeps compiled CSS tracked', () => {
    expect(git(['ls-files', '--', 'public/css/style.css'])).to.equal('public/css/style.css\n');
  });

  it('keeps signed fixtures under test fixtures', () => {
    const fixture = git(['ls-files', '--', 't/fixtures/elastic-license-2.0.txt']);

    expect(fixture).to.equal('t/fixtures/elastic-license-2.0.txt\n');
  });
});
