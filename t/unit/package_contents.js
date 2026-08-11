'use strict';

/*
 * Guards what the published npm package will actually contain.
 *
 * The contents are taken from `npm pack --dry-run --json`, i.e. from the very
 * tool that will build the tarball. No directory walk and no re-implementation
 * of the inclusion rules: the always-include set, the negation syntax and
 * nested ignore files are not faithfully reproducible, and an approximate copy
 * yields a spec that goes green by its own rules instead of the rules of the
 * tool that ships the artefact.
 *
 * Which assertions here have teeth, and which do not. Measured on npm 10.9.8:
 * LICENSE.md and README.md are added to every package regardless of the
 * `files` whitelist, and cannot be excluded even by negation. So "LICENSE.md is
 * in the package" would stay green with a completely broken whitelist - it is
 * kept below for a readable report and is explicitly not a gate. The teeth are
 * on NOTICE, which is NOT part of the always-include set and would simply not
 * ship unless listed, on the operator documents named one by one, and on the
 * assertions about absence.
 *
 * An honest caveat about the absence assertions. Two of the forbidden prefixes
 * - the local planning directory and the editor settings directory - are not
 * tracked by git and are therefore absent from a clean CI checkout by
 * themselves; there those assertions hold trivially and their teeth are in the
 * local run. The remaining ones - t/, portal/, scripts/, .github/, outputs/,
 * deploy/, scss/ - are in git, so those assertions work in CI as well.
 *
 * No assertion is made about the total number of entries: that figure drifts
 * with every commit and has already moved several times while this phase was
 * being planned.
 */

const {execFileSync} = require('child_process');
const path = require('path');
const {expect} = require('chai');

const ROOT = path.join(__dirname, '..', '..');

const OPERATOR_DOCS = [
  'docs/EULA.md',
  'docs/licensing-faq.md',
  'docs/install-local-npm.md',
  'docs/faq.md',
];

const APPLICATION_PATHS = [
  'app.js',
  'bin/',
  'config/',
  'docker/',
  'lib/',
  'locales/',
  'migrations/',
  'views/',
  'public/',
];

const FORBIDDEN_PREFIXES = [
  '.planning/',
  't/',
  'portal/',
  'scripts/',
  'outputs/',
  'deploy/',
  'scss/',
  '.github/',
  '.zcode/',
];

describe('Published package contents', function() {
  this.timeout(30000); // npm pack takes about a second locally, more on a runner

  let paths;

  before(function() {
    const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    paths = JSON.parse(raw)[0].files.map(entry => entry.path);
  });

  it('ships the attribution file, which npm does not add for free', function() {
    expect(
      paths,
      'NOTICE is not part of the always-include set: unlisted, it simply does not ship'
    ).to.include('NOTICE');
  });

  it('ships every operator document named for delivery', function() {
    OPERATOR_DOCS.forEach(doc => {
      expect(paths, doc + ' is missing from the package').to.include(doc);
    });
  });

  it('ships the runnable application', function() {
    APPLICATION_PATHS.forEach(prefix => {
      expect(
        paths.some(entry => entry === prefix || entry.startsWith(prefix)),
        'nothing under ' + prefix + ' is shipped'
      ).to.equal(true);
    });
  });

  it('leaks nothing from planning, tests, portal or CI tooling', function() {
    const leaked = paths.filter(entry =>
      FORBIDDEN_PREFIXES.some(prefix => entry.startsWith(prefix))
    );

    expect(
      leaked,
      'these paths would be published to the registry'
    ).to.deep.equal([]);
  });

  it('does not ship internal design documents', function() {
    expect(
      paths,
      'the documents are listed one by one precisely so this one stays out'
    ).to.not.include('docs/license-portal-design.md');
  });

  // Not a gate: npm adds LICENSE.md to every package whether or not the
  // whitelist mentions it, so this stays green even with the whitelist broken.
  // Kept for a readable report of what a consumer receives.
  it('ships the licence text', function() {
    expect(paths).to.include('LICENSE.md');
  });
});
