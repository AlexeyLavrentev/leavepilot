'use strict';

/*
  BRAND-02 invariant watchdog.

  02-02 routed every TIMEOFF_* read through lib/env_resolver.js, which made
  "all branded env reads go via the resolver" a one-time cleanup. The next
  commit can silently undo a cleanup, so this test turns it into an enforced
  contract instead: it fails the build the moment a developer adds a direct
  process.env.TIMEOFF_/LEAVEPILOT_/BRAND_ read anywhere outside the resolver.

  Modeled on t/unit/license_consistency.js (offender list + read() helper +
  teeth assertions + surfaces-exist guard) and t/unit/edition_community_boundary.js
  (recursive scanPath/scanFile over lib/, bin/, portal/).

  Scope (scannedPaths): app.js, lib/, bin/, portal/ — the production source the
  resolver contract covers. t/ is deliberately out of scope: tests legitimately
  set process.env.TIMEOFF_* as fixtures, and a watchdog that flagged its own
  fixtures would be switched off within a week.

  Allowlist (allowedReadSites): lib/env_resolver.js — the SOLE permitted read
  site. A single explicit file, not a glob (prohibition P: no broad globs); the
  exemption carries teeth below so it can never guard nothing.

  Read detection: a direct read of a branded env var in either dot-access
  (process.env.TIMEOFF_X) or quoted-bracket form (process.env['TIMEOFF_X']). The
  resolver's COMPUTED bracket access (process.env[<prefix>+surname]) does NOT
  match either form — the bracket alternative requires a quoted literal key — so
  the resolver is invisible to the offender scan by design, and the allowlist is
  forward-looking (a literal read added to the resolver later is exempted). The
  teeth assertion proves the resolver genuinely reads process.env, so the
  exemption is never a no-op.
*/

var expect = require('chai').expect;
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..', '..');

var read = function(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
};

// Production source surfaces the resolver contract covers. Recursed with
// listJsFiles (edition_community_boundary.js scanPath shape).
var scannedPaths = ['app.js', 'lib', 'bin', 'portal'];

// The single permitted read site — a file path (posix-relative), not a glob.
// Every exemption carries a teeth assertion (prohibition P against broad globs).
var allowedReadSites = ['lib/env_resolver.js'];

// A direct read of a branded env var. Two forms:
//   - dot access:     process.env.TIMEOFF_LICENSE
//   - quoted bracket: process.env['TIMEOFF_LICENSE'] / process.env["TIMEOFF_..."]
// Computed bracket access — process.env[<expr>] with a non-literal expression,
// which is how the resolver reads — does NOT match: the bracket form requires a
// quoted literal key. The 'g' flag lets accessEnds() enumerate every access on
// a line (a line may carry more than one); lastIndex is reset before each scan.
var readDots = /process\.env\.(TIMEOFF_|LEAVEPILOT_|BRAND_)[A-Z_0-9]+/g;
var readBracket = /process\.env\[['"](TIMEOFF_|LEAVEPILOT_|BRAND_)[A-Z_0-9]+['"]\]/g;

// End-indices (exclusive) of every branded env-var access on the line. Each end
// index is the position immediately AFTER the matched token, used to test
// whether that access is a write-assignment.
function accessEnds(line) {
  var ends = [];
  [readDots, readBracket].forEach(function(re) {
    re.lastIndex = 0;
    var m;
    while ((m = re.exec(line)) !== null) {
      ends.push(m.index + m[0].length);
      // Guard against zero-length matches looping forever (the patterns require
      // [A-Z_0-9]+ so this never happens today, but keep the scan defensive).
      if (m[0] === '') {
        re.lastIndex += 1;
      }
    }
  });
  return ends;
}

// An access is a write-assignment when, immediately after the matched token
// (optional whitespace), comes a single '=' that is NOT followed by another '='
// — so '==' / '===' (comparison, a read) and '+=' / '-=' are NOT writes. This
// keeps bin/license.js canonical LEAVEPILOT_* writes (L126, L146) legitimate:
// they populate process.env so features.verifyLicenseEnvelope picks the value up
// via the resolver; they are writes, not reads (read/write adjacency edge).
function isWriteAssignment(line, accessEnd) {
  return /^\s*=(?!=)/.test(line.slice(accessEnd));
}

function isAllowed(relativePath) {
  return allowedReadSites.indexOf(relativePath) !== -1;
}

function listJsFiles(absPath, into) {
  if (!fs.existsSync(absPath)) {
    return;
  }
  var stats = fs.statSync(absPath);
  if (stats.isDirectory()) {
    fs.readdirSync(absPath).forEach(function(child) {
      // Skip dependency / VCS / build noise defensively, even though the
      // scanned top-level dirs do not contain it today.
      if (child === 'node_modules' || child === '.git') {
        return;
      }
      listJsFiles(path.join(absPath, child), into);
    });
    return;
  }
  if (stats.isFile() && path.extname(absPath) === '.js') {
    into.push(absPath);
  }
}

// Every .js file under scannedPaths (files and directories both handled).
function collectFiles() {
  var files = [];
  scannedPaths.forEach(function(scanned) {
    var abs = path.join(root, scanned);
    if (!fs.existsSync(abs)) {
      return;
    }
    if (fs.statSync(abs).isFile()) {
      files.push(abs);
      return;
    }
    listJsFiles(abs, files);
  });
  return files;
}

// True when the line carries a branded env READ in any detected form. The
// dot / quoted-bracket / template-bracket forms are reads when at least one
// access on the line is not a write-assignment. offendersIn delegates here so
// the per-line contract has one definition (license_consistency offendersFor
// L82-90 shape).
function lineHasBrandedRead(line) {
  var ends = accessEnds(line);
  if (ends.length === 0) {
    return false;
  }
  return ends.some(function(end) {
    return !isWriteAssignment(line, end);
  });
}

// Offender objects { file, line, text } for one file. Allowlisted files
// contribute nothing (the sole permit). A line is an offender when
// lineHasBrandedRead(line) is true.
function offendersIn(absFile) {
  var relativePath = path.relative(root, absFile).split(path.sep).join('/');
  if (isAllowed(relativePath)) {
    return [];
  }
  var found = [];
  read(relativePath).split('\n').forEach(function(line, index) {
    if (lineHasBrandedRead(line)) {
      found.push({ file: relativePath, line: index + 1, text: line.trim() });
    }
  });
  return found;
}

// Deterministic file-then-line offender list (BRAND-02 ordering edge). Sorting
// by (file, then numeric line) — NOT lexicographic on the formatted string — so
// line 2 sorts before line 10 within the same file.
function allOffenders() {
  var offenders = [];
  collectFiles().forEach(function(file) {
    offendersIn(file).forEach(function(offender) {
      offenders.push(offender);
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

function format(offenders) {
  return offenders.map(function(o) {
    return o.file + ':' + o.line + ': ' + o.text;
  }).join('\n');
}

describe('BRAND-02 invariant: all branded env reads go through the resolver', function() {

  var offenders = allOffenders();

  // surfaces-exist (license_consistency L101-106): a watchdog whose scanned
  // paths resolve to no files is green for the wrong reason. The four scanned
  // paths hold ~170 .js files today; the threshold is deliberately modest so a
  // legitimate edit never trips it, while an empty/broken scan does.
  it('has surfaces to check', function() {
    expect(
      collectFiles().length,
      'the watchdog lost its input — scannedPaths resolved to too few .js files, so a green run proves nothing'
    ).to.be.above(20);
  });

  // The contract itself. This is the spec that fails the build on regression.
  it('has no direct TIMEOFF_/LEAVEPILOT_/BRAND_ reads outside the resolver', function() {
    expect(offenders, 'direct branded env reads must go through lib/env_resolver.js:\n' + format(offenders))
      .to.deep.equal([]);
  });

  // TEETH (load-bearing allowlist, license_consistency L124-137 / L707-714):
  // the resolver genuinely reads process.env, so allowlisting it is never a
  // silent hole. The resolver reads via COMPUTED bracket access
  // (process.env[<prefix>+surname]) — NOT a literal token — so this teeth
  // asserts the bracket-read mechanism is present, not a literal match (which
  // the resolver deliberately avoids so it does not trip its own watchdog).
  // If the resolver stopped reading process.env, the allowlist would guard
  // nothing and this assertion would fail.
  it('allowlists a resolver that genuinely reads process.env', function() {
    var resolver = read('lib/env_resolver.js');
    expect(
      /process\.env\[/.test(resolver),
      'lib/env_resolver.js no longer reads process.env, so allowlisting it guards nothing'
    ).to.equal(true);
  });

  // TEETH (negative control): the densest pre-phase read sites no longer read
  // branded env directly. lib/features.js (12 TIMEOFF_* reads pre-02-02) and
  // lib/branding.js (15 BRAND_* reads pre-02-01) were routed in 02-01/02-02; if
  // either regressed, this fails — proving the scan looks where the reads used
  // to be, not somewhere they were never dense.
  it('a routed consumer no longer reads branded env directly', function() {
    expect(
      offendersIn(path.join(root, 'lib', 'features.js')),
      'lib/features.js regressed to a direct branded env read (it was the densest TIMEOFF_* read site before 02-02)'
    ).to.deep.equal([]);
    expect(
      offendersIn(path.join(root, 'lib', 'branding.js')),
      'lib/branding.js regressed to a direct branded env read (it was the densest BRAND_* read site before 02-01)'
    ).to.deep.equal([]);
  });

  // TEETH (write-filter): a permitted write exists in scope and the offender
  // scan does not flag it. bin/license.js L126/L146 canonicalize LEAVEPILOT_*
  // writes (read/write adjacency edge); the filter must keep them legitimate.
  it('does not flag write-assignments as reads', function() {
    var license = read('bin/license.js');
    expect(
      /process\.env\.LEAVEPILOT_LICENSE_(PUBLIC_KEY|SECRET)\s*=/.test(license),
      'bin/license.js no longer carries its canonical LEAVEPILOT_* write-assignment — the write-filter has nothing to prove itself on'
    ).to.equal(true);

    var licenseOffenders = offendersIn(path.join(root, 'bin', 'license.js'));
    expect(
      licenseOffenders,
      'bin/license.js write-assignments are being flagged as reads — the write-filter is broken:\n' + format(licenseOffenders)
    ).to.deep.equal([]);
  });

  // TEETH (read-form coverage, WR-02 / G-02-5): the watchdog must catch a
  // branded env read in ANY of the four JS forms a future contributor might
  // reach for — not just the dot and quoted-bracket forms present in the
  // codebase today. Destructuring from process.env and template-literal
  // bracket access are natural idioms that would otherwise bypass the
  // invariant silently. The negative cases (a non-branded destructuring; a
  // template-bracket WRITE) prove the flag is not vacuous.
  it('flags every branded env read form (destructuring + template-bracket teeth)', function() {
    // Destructuring FROM process.env — always a read (it cannot be a write).
    expect(lineHasBrandedRead('const { TIMEOFF_LICENSE } = process.env;'),
      'single-name destructuring of a branded var must be flagged').to.equal(true);
    expect(lineHasBrandedRead('const { LEAVEPILOT_LICENSE, BRAND_NAME } = process.env;'),
      'multi-name destructuring carrying a branded var must be flagged').to.equal(true);
    expect(lineHasBrandedRead('const { PATH, HOME } = process.env;'),
      'a non-branded destructuring must NOT be flagged').to.equal(false);

    // Template-literal bracket — a read when not a write-assignment.
    expect(lineHasBrandedRead('const v = process.env[`TIMEOFF_LICENSE`];'),
      'a template-literal bracket read of a branded var must be flagged').to.equal(true);
    expect(lineHasBrandedRead('process.env[`LEAVEPILOT_LICENSE`] = "x";'),
      'a template-literal bracket WRITE must NOT be flagged').to.equal(false);
  });
});
