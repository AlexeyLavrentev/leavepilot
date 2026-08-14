'use strict';

/*
  D-01 companion gate: the dialect-sensitive spec manifest cannot go stale.

  Phase 5 audits the tree for specs whose subject matter behaves
  differently on SQLite and MySQL (day calculation, date arithmetic,
  transactions/locking, raw SQL) and fixes the result in
  t/fixtures/dialect-sensitive-specs.json BEFORE this test was written —
  the grep-before-test convention of t/fixtures/oem-leak-surfaces.json
  (04-03). The manifest's specs[].file list doubles as the run list of
  the MySQL dialect CI job (plan 05-05), so a spec that belongs on that
  list but is missing from the manifest would simply never run on MySQL,
  and nothing anywhere would turn red. A static list with that job
  silently rots; this test turns it into an enforced contract instead.

  Modeled on t/unit/oem_no_vendor_leak.js §6 (the companion grep:
  re-derive the list from code, fail on divergence) and
  t/unit/env_read_invariant.js (the scanner anatomy: recursive walk,
  offender objects {file, line, signal, text}, surfaces-exist guard,
  deterministic file-then-line ordering, positive/negative teeth).

  Detector families — the same six the audit used (see the manifest's
  _comment for the reproducible method). Deliberately conservative,
  known signal signatures only: a false positive would force a pointless
  manifest entry, and an entry with no honest reason is worse than no
  entry. The families with zero carriers today (sequelize.literal, SQL
  date functions) are kept: they are the first thing the next dialect-
  sensitive module will reach for, and they carry teeth below.

  Self-exclusion: this file is the one .js under t/ that necessarily
  contains every signal signature (they are its detector definitions),
  so the scan skips exactly one path — its own — with the reason stated
  here rather than hidden in a glob. Everything else under t/ that shows
  a signal must be a manifest entry or the build fails.

  Manifest entry contract (non-phantom): every entry's file exists; an
  entry whose spec file itself carries a detector-visible signal is
  self-signaled; an entry whose sensitivity lives in a lib module (the
  day-calculation carriers) must name that module in `module` and in its
  `reason`, and the gate verifies the module path exists — the manifest
  lists specs, not modules, so the module reference is the proof the
  entry guards something real.
*/

var expect = require('chai').expect;
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var manifest = JSON.parse(fs.readFileSync(path.join(root, 't', 'fixtures', 'dialect-sensitive-specs.json'), 'utf8'));

// The one file the scan skips: this gate itself (see header). A single
// explicit relative path, not a glob.
var SELF_PATH = 't/unit/dialect_sensitive_manifest.js';

var read = function(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
};

// ---------------------------------------------------------------------------
// Detector families (audit method, recorded in the manifest _comment).
// Each maps a stable signal name -> regex over source text. Known
// signatures only; anything broader starts manufacturing entries.
// ---------------------------------------------------------------------------

var SIGNAL_FAMILIES = [
  {
    signal: 'sql-literal-injection',
    reason: 'sequelize.literal / Sequelize.literal',
    pattern: /sequelize\.literal|Sequelize\.literal/,
  },
  {
    signal: 'raw-sql-query',
    reason: "raw sequelize.query(",
    pattern: /sequelize\.query\(/,
  },
  {
    signal: 'between-predicate',
    reason: 'Op.between or an SQL "X BETWEEN a AND b" predicate line',
    pattern: /Op\.between|\bBETWEEN\b[^\n]*\bAND\b/,
  },
  {
    signal: 'sql-date-function',
    reason: 'SQL date function (DATEDIFF, DATE_ADD, DATE_SUB, DATE_FORMAT, strftime, julianday)',
    pattern: /\b(DATEDIFF|DATE_ADD|DATE_SUB|DATE_FORMAT|strftime|julianday)\s*\(/i,
  },
  {
    signal: 'transaction-locking',
    reason: 'sequelize.transaction / .transaction(',
    pattern: /sequelize\.transaction|\.transaction\(/,
  },
  {
    signal: 'tz-arithmetic',
    reason: "explicit TZ arithmetic (moment-timezone, moment().tz('...'), .tz('...'))",
    pattern: /moment-timezone|moment_tz|moment\(\)\.tz\(|\.tz\(['"]/,
  },
];

// Every signal a single source text carries, as offender-style objects
// {file, line, signal, text}. Line-level so the failure message points
// at the offending code, like env_read_invariant's offendersIn.
function signalsIn(relativePath, source) {
  var found = [];
  source.split('\n').forEach(function(line, index) {
    SIGNAL_FAMILIES.forEach(function(family) {
      family.pattern.lastIndex = 0;
      if (family.pattern.test(line)) {
        found.push({
          file: relativePath,
          line: index + 1,
          signal: family.signal,
          text: line.trim(),
        });
      }
    });
  });
  return found;
}

// ---------------------------------------------------------------------------
// The scan: every .js file under t/ except this gate (env_read_invariant
// listJsFiles shape).
// ---------------------------------------------------------------------------

function listJsFiles(absPath, into) {
  if (!fs.existsSync(absPath)) {
    return;
  }
  var stats = fs.statSync(absPath);
  if (stats.isDirectory()) {
    fs.readdirSync(absPath).forEach(function(child) {
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

function collectSpecFiles() {
  var files = [];
  listJsFiles(path.join(root, 't'), files);
  return files.map(function(abs) {
    return path.relative(root, abs).split(path.sep).join('/');
  }).filter(function(rel) {
    return rel !== SELF_PATH;
  }).sort();
}

function accountedSet() {
  var set = {};
  manifest.specs.forEach(function(entry) {
    set[entry.file] = true;
  });
  return set;
}

// Offender hits within ONE already-read source: the signals the text
// carries, kept only when the file is not accounted for in the manifest.
// Pure (path, source, accounted) -> hits, so the fabricated-entry teeth
// can prove the contract on synthetic input instead of corrupting the
// real manifest on disk.
function offenderHits(relativePath, source, accounted) {
  if (accounted[relativePath]) {
    return [];
  }
  return signalsIn(relativePath, source);
}

// Offenders across the real scan: every signal-carrying spec file
// absent from the manifest, deterministic file-then-line-then-signal.
function offendersAmong(relativeFiles, accounted) {
  var offenders = [];
  relativeFiles.forEach(function(rel) {
    offenderHits(rel, read(rel), accounted).forEach(function(hit) {
      offenders.push(hit);
    });
  });
  offenders.sort(function(a, b) {
    if (a.file !== b.file) {
      return a.file < b.file ? -1 : 1;
    }
    if (a.line !== b.line) {
      return a.line - b.line;
    }
    return a.signal < b.signal ? -1 : 1;
  });
  return offenders;
}

function format(offenders) {
  return offenders.map(function(o) {
    return o.file + ':' + o.line + ' [' + o.signal + ']: ' + o.text;
  }).join('\n');
}

// Self-signaled: the spec file itself carries a detector-visible signal.
function selfSignalCount(entry) {
  return signalsIn(entry.file, read(entry.file)).length;
}

describe('D-01 dialect-sensitive spec manifest (companion gate)', function() {

  var specFiles = collectSpecFiles();
  var accounted = accountedSet();
  var offenders = offendersAmong(specFiles, accounted);

  // (1) SURFACES-EXIST: a scan whose input resolves to nothing, or an
  // empty manifest, is green for the wrong reason (license_consistency /
  // env_read_invariant guard). The t/ tree holds 200+ .js files today;
  // the threshold is modest so a legitimate edit never trips it, while a
  // broken walk does.
  it('has spec files to scan (surfaces-exist)', function() {
    expect(
      specFiles.length,
      'the companion scan lost its input — the t/ walk resolved to too few .js files'
    ).to.be.above(100);
  });

  it('has a non-empty manifest with every category populated', function() {
    expect(manifest.specs.length, 'the manifest is empty — the MySQL run list would be empty too')
      .to.be.above(0);
    manifest.categories.forEach(function(category) {
      var count = manifest.specs.filter(function(entry) {
        return entry.category === category;
      }).length;
      expect(
        count,
        'category "' + category + '" has no entries — an empty category must be explained in the manifest _comment (D-01: owner reviews category composition)'
      ).to.be.above(0);
    });
  });

  // (2) RE-DERIVATION, the staleness contract itself. This is the spec
  // that fails the build when a dialect-sensitive spec appears outside
  // the manifest.
  it('has no signal-carrying spec outside the manifest', function() {
    expect(
      offenders,
      'these files carry dialect-sensitive signals but are NOT in t/fixtures/dialect-sensitive-specs.json — the manifest has gone stale; add them (with an honest reason) or reclassify:\n'
        + format(offenders)
    ).to.deep.equal([]);
  });

  // (3) NON-PHANTOM: every entry's file exists, and each entry is
  // anchored to something real — either its own spec source shows a
  // detector-visible signal, or its reason names an existing module
  // that carries the sensitivity. The manifest cannot list phantoms.
  it('has no phantom entries (file exists, signal or module verified)', function() {
    var phantoms = [];
    manifest.specs.forEach(function(entry) {
      if (!fs.existsSync(path.join(root, entry.file))) {
        phantoms.push(entry.file + ': file does not exist');
        return;
      }
      if (selfSignalCount(entry) > 0) {
        return; // self-signaled: the signal is visible in the spec source
      }
      if (!entry.module) {
        phantoms.push(entry.file + ': no detector-visible signal in the spec and no module named — the entry guards nothing');
        return;
      }
      if (!fs.existsSync(path.join(root, entry.module))) {
        phantoms.push(entry.file + ': named module ' + entry.module + ' does not exist');
        return;
      }
      if (entry.reason.indexOf(entry.module) === -1) {
        phantoms.push(entry.file + ': the reason must name the module (' + entry.module + ') it depends on');
      }
    });
    expect(
      phantoms,
      'these manifest entries are phantoms — the file, its signal, or its named module is gone:\n'
        + phantoms.join('\n')
    ).to.deep.equal([]);
  });

  // (3b) NON-PHANTOM teeth: the self-signaled half of the manifest is
  // not vacuous — at least one entry genuinely carries a detector-
  // visible signal in its own spec source (oem_no_vendor_leak L457-463
  // allowlist-non-vacuous shape). If none did, the re-derivation would
  // be guarding a list the detector can never see.
  it('has self-signaled entries the detector can actually see', function() {
    var selfSignaled = manifest.specs.filter(function(entry) {
      return selfSignalCount(entry) > 0;
    });
    expect(
      selfSignaled.length,
      'no manifest entry carries a detector-visible signal in its spec source — the re-derivation scan and the manifest have nothing in common'
    ).to.be.above(0);
  });

  // (4) POSITIVE TEETH: the detector flags a synthetic snippet from
  // every signal family — including the two families with zero carriers
  // in the tree today (sequelize.literal, SQL date functions), which is
  // exactly what the next dialect-sensitive module will reach for.
  it('flags a synthetic snippet from every signal family', function() {
    var synthetic = [
      "await sequelize.query('SELECT 1 FROM Leaves WHERE id = ' + id);", // raw-sql-query
      'const clause = sequelize.literal("DATE(date_start)");',           // sql-literal-injection
      'const window = { date_start: { [Op.between]: [a, b] } };',        // between-predicate
      "const sql = 'SELECT DATEDIFF(day, a, b) FROM Leaves';",           // sql-date-function
      'await sequelize.transaction(function(t) { return save(t); });',   // transaction-locking
      "const today = moment().tz('Europe/London');",                     // tz-arithmetic
    ].join('\n');
    var hits = signalsIn('t/unit/__synthetic__.js', synthetic);
    var seen = {};
    hits.forEach(function(hit) {
      seen[hit.signal] = true;
    });
    SIGNAL_FAMILIES.forEach(function(family) {
      expect(
        seen[family.signal],
        'the detector failed to flag the synthetic ' + family.signal + ' snippet — the family is blind'
      ).to.equal(true);
    });
  });

  // (5) NEGATIVE TEETH: a spec doing only ordinary model calls through
  // Sequelize's dialect-abstracted API is NOT flagged. The detector
  // must stay conservative: a false positive here forces a manifest
  // entry with no honest reason.
  it('does not flag ordinary model calls', function() {
    var ordinary = [
      "const user = await models.User.findOne({ where: { id: 1 } });",
      "await user.update({ name: 'Example' });",
      "const leave = await models.Leave.create({ date_start: '2030-01-01', date_end: '2030-01-02' });",
      'expect(leave.get_days().length).to.equal(2);',
    ].join('\n');
    var hits = signalsIn('t/unit/__ordinary__.js', ordinary);
    expect(
      hits,
      'ordinary model calls were flagged — the detector is too broad, it would force pointless manifest entries:\n'
        + format(hits)
    ).to.deep.equal([]);
  });

  // (5b) FABRICATED OUT-OF-MANIFEST SCENARIO: the staleness contract
  // really does fail a spec that is not in the manifest. Proven on
  // synthetic input (a made-up path and source fed through the same
  // offender filter the real scan uses), not by corrupting the real
  // manifest on disk — the manifest is the contract under test, not a
  // fixture to mutate.
  it('fails a fabricated out-of-manifest signal carrier', function() {
    var fabricatedPath = 't/unit/__fabricated_dialect_spec.js';
    var fabricatedSource = "const rows = await sequelize.query('SELECT date_start FROM Leaves');";

    // Sanity: the fabricated path really is outside the manifest,
    // otherwise this teeth proves nothing.
    expect(accounted[fabricatedPath], 'the fabricated path must not be a manifest entry').to.not.equal(true);

    var hits = offenderHits(fabricatedPath, fabricatedSource, accounted);
    expect(
      hits.map(function(o) { return o.file + ' [' + o.signal + ']'; }),
      'a signal-carrying file outside the manifest must become an offender naming the file and the signal'
    ).to.deep.equal([fabricatedPath + ' [raw-sql-query]']);

    // And the mirror: the same source accounted for in the manifest
    // produces no offender — the contract fails on absence, not on the
    // signal itself.
    var accountedFor = offenderHits(fabricatedPath, fabricatedSource, (function() {
      var set = Object.assign({}, accounted);
      set[fabricatedPath] = true;
      return set;
    })());
    expect(accountedFor, 'an accounted-for signal carrier must not be an offender').to.deep.equal([]);
  });

  // (6) DETERMINISTIC ORDERING: file, then numeric line, then signal —
  // not lexicographic on the formatted string (BRAND-02 ordering edge:
  // line 2 must sort before line 10).
  it('orders offenders file-then-line deterministically', function() {
    var synthetic = signalsIn('t/unit/__order__.js', [
      'await sequelize.transaction(function(t) { return t; });',
      'const q = sequelize.query(\'SELECT 1\');',
      'const w = sequelize.query(\'SELECT 2\');',
    ].join('\n'));
    var ordered = synthetic.slice().sort(function(a, b) {
      if (a.file !== b.file) { return a.file < b.file ? -1 : 1; }
      if (a.line !== b.line) { return a.line - b.line; }
      return a.signal < b.signal ? -1 : 1;
    });
    expect(synthetic.map(function(o) { return o.line; }))
      .to.deep.equal(ordered.map(function(o) { return o.line; }));
    expect(synthetic.map(function(o) { return o.line; }))
      .to.deep.equal([1, 2, 3]);
  });
});
