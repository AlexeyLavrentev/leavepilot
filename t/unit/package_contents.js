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
 * An honest caveat about the absence assertions. Three of the forbidden
 * prefixes - the local planning directory, the editor settings directory and
 * the portal/ tree removed from the repository by the phase-9 surgery - are
 * not tracked by git and are therefore absent from a clean CI checkout by
 * themselves; there those assertions hold trivially (the portal/ prefix
 * stays listed as the tarball-side second line of defence against the tree
 * ever regaining portal code). The remaining ones - t/, scripts/, .github/,
 * outputs/, deploy/, scss/ - are in git, so those assertions work in CI as
 * well.
 *
 * No assertion is made about the total number of entries: that figure drifts
 * with every commit and has already moved several times while this phase was
 * being planned.
 *
 * The dead-entry assertion is generative rather than a fixed list: it takes the
 * shipped bin/*.js scripts, reads each one off the disk, finds every relative
 * `require()` (a specifier that starts with a dot), resolves it against the
 * file's own directory, and asks whether the resolved path - or its .js, .json
 * or /index.js form, or any shipped path sharing its prefix - is itself in the
 * tarball. A script that reaches outside the package for its own dependencies
 * is a file the consumer's install will crash on at the first resolution. The
 * seventh such entry, added in six months, is caught by the same assertion
 * without another edit here - which is the point of computing the offenders
 * instead of naming the six that were measured at plan time.
 */

const {execFileSync} = require('child_process');
const fs = require('fs');
const path = require('path');
const {expect} = require('chai');

const ROOT = path.join(__dirname, '..', '..');

const OPERATOR_DOCS = [
  'docs/EULA.md',
  'docs/CLA-individual.md',
  'docs/CLA-corporate.md',
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

// Every shipped bin/*.js whose relative require() cannot be satisfied from
// inside the tarball. The set is computed, not listed: a script added later
// that reaches outside the package is caught by the same pass without another
// edit here. Resolution mirrors Node's own: the specifier is normalised
// against the file's directory, then matched as the exact path, with .js,
// .json or /index.js appended, or as a directory prefix shared by a shipped
// path. Specifiers that do not start with a dot are packages or built-ins and
// are outside this assertion's scope.
const deadEntryOffenders = shippedPaths => {
  const shippedSet = new Set(shippedPaths);
  const offenders = [];

  for (const entry of shippedPaths) {
    if (!entry.startsWith('bin/') || !entry.endsWith('.js')) {
      continue;
    }

    let source;
    try {
      source = fs.readFileSync(path.join(ROOT, entry), 'utf8');
    } catch (e) {
      continue;
    }

    const requires = [...source.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)].map(m => m[1]);

    for (const specifier of requires) {
      const resolved = path.posix.normalize(
        path.posix.dirname(entry) + '/' + specifier
      );
      const candidates = [
        resolved,
        resolved + '.js',
        resolved + '.json',
        resolved + '/index.js',
      ];
      const isDirectoryPrefix = [...shippedSet].some(p => p.startsWith(resolved + '/'));

      if (!candidates.some(c => shippedSet.has(c)) && !isDirectoryPrefix) {
        offenders.push(entry + ' -> ' + specifier);
      }
    }
  }

  return offenders;
};

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

  // Repo/CI-only bin scripts: their `npm run` entries target the checkout,
  // but the files they drive are (deliberately) not in the tarball, so
  // shipping the script itself only advertises a broken entry
  // (bin/demo.js drives docker-compose.demo.yml; bin/screenshots.js drives
  // bin/demo.js; bin/install_check.js drives the repo's own docs and
  // fixtures). Same class as the already-excluded bin/test.js.
  it('does not ship the repo-only demo/screenshots/install-check bin scripts', function() {
    ['bin/demo.js', 'bin/screenshots.js', 'bin/install_check.js'].forEach(script => {
      expect(
        paths,
        script + ' must stay out of the tarball: its target files (compose file, docs, fixtures) are not shipped, so the packaged script would only crash'
      ).to.not.include(script);
    });
  });

  it('does not ship bin scripts whose own dependencies reach outside the package', function() {
    const offenders = deadEntryOffenders(paths);

    expect(
      offenders,
      'these shipped bin/*.js scripts require() a relative path that is not itself in the tarball; a consumer install crashes on the first one'
    ).to.deep.equal([]);
  });

  it('ships enough bin scripts for the dead-entry check to bite', function() {
    const shippedBinScripts = paths.filter(p => p.startsWith('bin/') && p.endsWith('.js'));

    expect(
      shippedBinScripts.length,
      'the dead-entry assertion above is satisfied by an empty bin set; guard the floor so a stripped whitelist reads as a failure, not as clean'
    ).to.be.greaterThan(5);
  });

  // Not a gate: npm adds LICENSE.md to every package whether or not the
  // whitelist mentions it, so this stays green even with the whitelist broken.
  // Kept for a readable report of what a consumer receives.
  it('ships the licence text', function() {
    expect(paths).to.include('LICENSE.md');
  });
});
