'use strict';

/*
  D-02 invariant watchdog: no portal surface returns to the public repository.

  Phase 9 removed every portal surface in one surgical PR (09-01) and split the
  portal docs out of the public tree (09-02). Removal is a one-time act — the
  next commit can silently bring a surface back (a stray git revert, a
  copy-paste of an old workflow block, a "temporary" restore of the portal
  directory). This test turns the removal into an enforced contract instead:
  it fails the build the moment any forbidden portal path exists anywhere in
  the working tree, or any forbidden portal identifier appears in the CI
  workflows or package.json.

  Modeled on t/unit/env_read_invariant.js (read() helper, recursive
  collectFiles walk with existsSync guards, offender objects with a
  deterministic file-then-line sort, surfaces-exist guard, deep-equal-to-empty
  contract with a formatted offender list, synthetic negative teeth) and
  t/unit/oem_no_vendor_leak.js (header style: why a watchdog, not a cleanup).

  TWO scan classes with DIFFERENT scope (research Pattern 1) — this is the
  load-bearing design decision of the file:

  - Forbidden PATHS (the portal directory, the portal Dockerfile/compose file,
    the portal test directory, the four deleted bin scripts) are checked
    REPO-WIDE via the tree walk. A path is a surface: if it exists anywhere,
    portal code has returned.

  - Forbidden IDENTIFIERS (the deleted CI job id, the deleted CI step name,
    the four deleted package.json "!bin/" negation entries) are checked ONLY
    inside .github/workflows/*.yml and package.json. Identifiers are NOT
    scanned repo-wide, for two carved-out reasons:
      1. docs/release-checklist.md L133 records, as a historical v3.0.0
         release fact, that the portal-docker-build job was green on the
         release SHA. History is not falsified; a repo-wide identifier ban
         would force exactly that.
      2. LICENSE-CONTRACT.md carries ~20 legitimate "Portal" role mentions
         (the portal is the contract's issuing counterparty). The contract
         package is not a portal surface and stays untouched.

  The watchdog forbids surfaces, not words: the docs/license-portal.md stub
  says "портал" by construction, bin/sign_license.js and
  bin/sign_revocation_list.js stay per D-05 (self-sufficient community CLI),
  and none of that is an offender.

  CI registration: NONE (Pitfall 8). bin/test.js runs
  `mocha --recursive t/unit` and test:coverage runs
  `nyc mocha --recursive t/unit`, so a file in t/unit/ is picked up
  automatically; the named contract-test list in core-ci.yml stays untouched.
  The file deliberately stays outside skip_honesty.
*/

var expect = require('chai').expect;
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..', '..');

var read = function(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
};

// Scan class 1: forbidden PATHS, checked repo-wide. A path is a surface: it
// must not exist at all. Directories are forbidden with everything inside
// them (prefix match with a trailing slash, so 'portal' forbids
// 'portal/models/index.js' without forbidding 'portal-anything' siblings).
var forbiddenPaths = [
  'portal',
  'Dockerfile.portal',
  'docker-compose.portal.yml',
  't/unit/portal',
  'bin/license_portal.js',
  'bin/portal_admin.js',
  'bin/import-registry.js',
  'bin/license_portal_backup.js',
];

// Scan class 2: forbidden IDENTIFIERS, checked ONLY in the two surfaces where
// they were live wiring (CI workflows + package.json files whitelist). Exact
// literals, not globs (prohibition P).
var identifierScanDirs = ['.github/workflows'];
var identifierScanFiles = ['package.json'];
var forbiddenIdentifiers = [
  'portal-docker-build',
  'Validate portal compose',
  '!bin/license_portal.js',
  '!bin/portal_admin.js',
  '!bin/import-registry.js',
  '!bin/license_portal_backup.js',
];

// True when the posix-relative path IS a forbidden path or sits INSIDE a
// forbidden directory. The stub docs/license-portal.md, sign_license.js and a
// hypothetical docs/portal-notes.md all fail every clause: the watchdog
// forbids surfaces, not words (Pitfall 4).
function pathOffenderFor(relativePosix) {
  for (var i = 0; i < forbiddenPaths.length; i++) {
    if (relativePosix === forbiddenPaths[i] ||
        relativePosix.indexOf(forbiddenPaths[i] + '/') === 0) {
      return { path: relativePosix, forbidden: forbiddenPaths[i] };
    }
  }
  return null;
}

// True when the line carries a forbidden identifier. Substring match on exact
// literals: '!bin/test.js' (a surviving negation entry) shares no literal with
// '!bin/license_portal.js', and the identifier scope — not this predicate — is
// what keeps the historical checklist record and the contract document safe.
function lineHasForbiddenIdentifier(line) {
  return forbiddenIdentifiers.some(function(identifier) {
    return line.indexOf(identifier) !== -1;
  });
}

// Recursive walk over the WHOLE working tree (every extension — portal
// surfaces were .js, .hbs, .sql, .md alike), skipping node_modules and .git
// defensively (a dependency shipping a 'portal' directory is not our surface).
// existsSync-guarded like env_read_invariant collectFiles (L134-148).
function collectTreeFiles(absPath, into) {
  if (!fs.existsSync(absPath)) {
    return;
  }
  var stats = fs.statSync(absPath);
  if (stats.isDirectory()) {
    fs.readdirSync(absPath).forEach(function(child) {
      if (child === 'node_modules' || child === '.git') {
        return;
      }
      collectTreeFiles(path.join(absPath, child), into);
    });
    return;
  }
  if (stats.isFile()) {
    into.push(absPath);
  }
}

function toRelativePosix(absFile) {
  return path.relative(root, absFile).split(path.sep).join('/');
}

// Offender objects for every file in the tree sitting on a forbidden path.
function allPathOffenders() {
  var offenders = [];
  var files = [];
  collectTreeFiles(root, files);
  files.forEach(function(file) {
    var relativePosix = toRelativePosix(file);
    var offender = pathOffenderFor(relativePosix);
    if (offender) {
      offenders.push(offender);
    }
  });
  offenders.sort(function(a, b) {
    return a.path < b.path ? -1 : (a.path > b.path ? 1 : 0);
  });
  return offenders;
}

// The ONLY files the identifier scan reads: *.yml/*.yaml inside
// .github/workflows plus the package.json whitelist surface. Documents are
// never in this list — that is the carve-out, and the teeth below assert it.
function identifierSurfaceFiles() {
  var files = [];
  identifierScanDirs.forEach(function(dir) {
    var absDir = path.join(root, dir);
    if (!fs.existsSync(absDir)) {
      return;
    }
    fs.readdirSync(absDir).forEach(function(child) {
      if (path.extname(child) === '.yml' || path.extname(child) === '.yaml') {
        files.push(dir + '/' + child);
      }
    });
  });
  identifierScanFiles.forEach(function(file) {
    if (fs.existsSync(path.join(root, file))) {
      files.push(file);
    }
  });
  return files.sort();
}

// Offender objects { file, line, text } for every forbidden-identifier line
// in the identifier surfaces. Same per-line shape as env_read_invariant
// offendersIn (L174-186), deterministic file-then-numeric-line sort (L191-205).
function allIdentifierOffenders() {
  var offenders = [];
  identifierSurfaceFiles().forEach(function(surface) {
    read(surface).split('\n').forEach(function(line, index) {
      if (lineHasForbiddenIdentifier(line)) {
        offenders.push({ file: surface, line: index + 1, text: line.trim() });
      }
    });
  });
  offenders.sort(function(a, b) {
    if (a.file !== b.file) {
      return a.file < b.file ? -1 : 1;
    }
    return a.line - b.line;
  });
  return offenders;
}

function formatPathOffenders(offenders) {
  return offenders.map(function(o) {
    return o.path + ' (forbidden surface: ' + o.forbidden + ')';
  }).join('\n');
}

function formatIdentifierOffenders(offenders) {
  return offenders.map(function(o) {
    return o.file + ':' + o.line + ': ' + o.text;
  }).join('\n');
}

describe('D-02 invariant: no portal surface returns to the public repository', function() {

  var pathOffenders = allPathOffenders();
  var identifierOffenders = allIdentifierOffenders();

  // surfaces-exist guard: a watchdog whose scan resolved to nothing is green
  // for the wrong reason. The working tree holds well over a thousand files;
  // the threshold is deliberately modest so a legitimate edit never trips it,
  // while an empty/broken walk does (env_read_invariant L221-226 shape).
  it('has tree surfaces to check', function() {
    var files = [];
    collectTreeFiles(root, files);
    expect(
      files.length,
      'the path watchdog lost its input — the tree walk resolved to too few files, so a green run proves nothing'
    ).to.be.above(1000);
  });

  // Same guard for the identifier half: the workflow directory must exist and
  // hold at least one workflow, and package.json must be scanned — otherwise
  // the identifier contract is vacuously green.
  it('has identifier surfaces to check', function() {
    expect(
      identifierSurfaceFiles(),
      'the identifier watchdog lost its input — no .github/workflows/*.yml and no package.json to scan'
    ).to.satisfy(function(files) {
      return files.indexOf('package.json') !== -1 &&
        files.some(function(file) { return file.indexOf('.github/workflows/') === 0; });
    });
  });

  // The contract itself, scan class 1. This is the spec that fails the build
  // on a returning portal path.
  it('has no portal paths anywhere in the working tree', function() {
    expect(pathOffenders, 'portal surfaces must not return to the public repository:\n' + formatPathOffenders(pathOffenders))
      .to.deep.equal([]);
  });

  // The contract itself, scan class 2.
  it('has no portal identifiers in CI workflows or package.json', function() {
    expect(identifierOffenders, 'portal identifiers must not return to CI or the tarball whitelist:\n' + formatIdentifierOffenders(identifierOffenders))
      .to.deep.equal([]);
  });

  // TEETH (scope carve-out is load-bearing, Pitfall 4): the historical
  // release-checklist record genuinely carries the deleted job id — so a
  // repo-wide identifier ban WOULD go red on history. The carve-out is what
  // keeps this watchdog green without falsifying the v3.0.0 record, and these
  // assertions pin both halves: the substring exists, and the file holding it
  // is not (and must not be) an identifier surface.
  it('keeps the historical release record out of identifier scope', function() {
    var checklist = read('docs/release-checklist.md');
    expect(
      /portal-docker-build/.test(checklist),
      'docs/release-checklist.md no longer carries the historical portal-docker-build record — the carve-out this file is built on has nothing to carve out'
    ).to.equal(true);
    expect(
      identifierSurfaceFiles().indexOf('docs/release-checklist.md'),
      'the release checklist is history, not a CI surface — scanning it for identifiers would force a history rewrite'
    ).to.equal(-1);
    expect(
      identifierSurfaceFiles().indexOf('LICENSE-CONTRACT.md'),
      'LICENSE-CONTRACT.md carries legitimate Portal role mentions — it is a contract surface, never an identifier surface'
    ).to.equal(-1);
  });

  // TEETH (synthetic paths must flag — research L169-177): the path detector
  // catches a returning directory member, a returning test file, a returning
  // script and the root surfaces by exact name. The negative cases prove the
  // flag is not vacuous: the stub, the D-05 survivors and word-only near
  // misses are not surfaces.
  it('flags synthetic portal paths and passes benign ones (negative teeth)', function() {
    expect(pathOffenderFor('portal/models/index.js'),
      'a file inside a restored portal/ directory must be flagged').to.not.equal(null);
    expect(pathOffenderFor('t/unit/portal/trial.js'),
      'a returning portal test spec must be flagged').to.not.equal(null);
    expect(pathOffenderFor('bin/license_portal.js'),
      'a returning portal bin script must be flagged').to.not.equal(null);
    expect(pathOffenderFor('Dockerfile.portal'),
      'the portal Dockerfile must be flagged').to.not.equal(null);
    expect(pathOffenderFor('docker-compose.portal.yml'),
      'the portal compose file must be flagged').to.not.equal(null);

    expect(pathOffenderFor('docs/license-portal.md'),
      'the D-09 stub mentions the portal — it is a document, not a surface').to.equal(null);
    expect(pathOffenderFor('bin/sign_license.js'),
      'sign_license.js stays per D-05 (self-sufficient community CLI)').to.equal(null);
    expect(pathOffenderFor('bin/sign_revocation_list.js'),
      'sign_revocation_list.js stays per D-05').to.equal(null);
    expect(pathOffenderFor('docs/portal-notes.md'),
      'a word-only near miss must not be flagged — surfaces, not words').to.equal(null);
  });

  // TEETH (synthetic identifier lines must flag; benign lines must not): the
  // deleted CI job/step shapes and the deleted package.json negation entries
  // are caught verbatim, while the surviving negation entries and the stub's
  // Russian portal prose pass. The line-level predicate is deliberately
  // substring-exact; scope decisions live in identifierSurfaceFiles above.
  it('flags synthetic identifier lines and passes benign ones (negative teeth)', function() {
    expect(lineHasForbiddenIdentifier('  portal-docker-build:'),
      'a restored CI job id must be flagged').to.equal(true);
    expect(lineHasForbiddenIdentifier('      - name: Validate portal compose'),
      'a restored CI step name must be flagged').to.equal(true);
    expect(lineHasForbiddenIdentifier('    "!bin/license_portal.js",'),
      'a restored package.json negation entry must be flagged').to.equal(true);
    expect(lineHasForbiddenIdentifier('    "!bin/import-registry.js",'),
      'a restored package.json negation entry must be flagged').to.equal(true);

    expect(lineHasForbiddenIdentifier('    "!bin/test.js",'),
      'a surviving negation entry is not a portal identifier').to.equal(false);
    expect(lineHasForbiddenIdentifier('    "!bin/fetch_user_stat.js",'),
      'a surviving negation entry is not a portal identifier').to.equal(false);
    expect(lineHasForbiddenIdentifier('node bin/sign_license.js generate --customer "ООО Ромашка"'),
      'a sign_license.js command is D-05 community truth, not a portal identifier').to.equal(false);
    expect(lineHasForbiddenIdentifier('**Портал — вендорская инфраструктура.** License Portal не входит в community-редакцию.'),
      'the stub\'s Russian portal prose must not be flagged — surfaces, not words').to.equal(false);
  });
});
