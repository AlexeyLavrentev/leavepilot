'use strict';

/*
  D-10 companion gate: the data-rewriting migration manifest cannot go stale.

  Plan 05-06 audits both migration histories for migrations whose up()
  rewrites ROWS and fixes the result in
  t/fixtures/data-rewriting-migrations.json BEFORE this test was written
  (the grep-before-test convention of 04-03 and 05-04). The manifest drives
  t/unit/db_migrations_data.js (one honest pre-state replay case per entry,
  D-08/D-09) and through it the MySQL dialect CI job, so a data-rewriting
  migration that is missing from the manifest would simply never be replayed
  on the state that existed before it - and nothing anywhere would turn red.
  A static list with that property silently rots; this test turns it into an
  enforced contract instead, modeled on t/unit/dialect_sensitive_manifest.js
  (05-04) and t/unit/oem_no_vendor_leak.js §6.

  Detector families - the transform signal families of the audit (see the
  manifest's _comment for the reproducible method). Deliberately
  conservative, known signal signatures only: a false positive would force a
  pointless manifest entry, and an entry with no honest reason is worse than
  no entry. The families are scanned over the up() body ONLY (down is not
  the upgrade path), plus the delegate module's source when an entry names
  one (the encrypt-sso migration's transforms live in
  lib/sso_secret_backfill.js).

  Scope of the scan: the two migration histories (migrations/,
  portal/migrations/) - NOT the t/ tree, so this gate does not need the
  self-exclusion dialect_sensitive_manifest.js carries; its own detector
  signatures live outside the scanned directories. Both histories are
  scanned even though portal currently has zero qualifying files: the
  surfaces-exist guard plus the scan itself mean a portal data-rewrite added
  later cannot escape the manifest.

  Manifest entry contract (non-phantom): every entry's migration file
  exists, its history field matches the path prefix (core -> migrations/,
  portal -> portal/migrations/), its up() body (or delegate) carries at
  least one detector-visible signal, a delegate entry names an existing
  module that the migration source actually requires, transforms is a
  non-empty string, and every entry points at the single replay spec. A
  migration whose up() shows a transform signal but has no manifest entry
  fails the build (staleness); a manifest entry whose migration shows no
  signal fails it too (phantom).
*/

var expect = require('chai').expect;
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var manifest = JSON.parse(
  fs.readFileSync(path.join(root, 't', 'fixtures', 'data-rewriting-migrations.json'), 'utf8')
);

var HISTORIES = {
  core: 'migrations',
  portal: 'portal/migrations',
};

var REPLAY_SPEC = 't/unit/db_migrations_data.js';

// ---------------------------------------------------------------------------
// Detector families (audit method, recorded in the manifest _comment).
// Known signatures only; anything broader starts manufacturing entries.
// ---------------------------------------------------------------------------

var LINE_FAMILIES = [
  {
    signal: 'bulk-update-rows',
    reason: 'queryInterface.bulkUpdate( rewriting existing rows',
    pattern: /queryInterface\.bulkUpdate\(/,
  },
  {
    signal: 'raw-update-statement',
    reason: 'raw UPDATE ... SET statement over existing rows',
    pattern: /\bUPDATE\b[^\n]*\bSET\b/i,
  },
  {
    signal: 'insert-select-backfill',
    reason: 'INSERT INTO ... SELECT copying existing rows (raw SQL backfills and table-rebuild copies; the SELECT half may sit on a continuation line)',
    pattern: /\bINSERT\s+INTO\b[^\n]*?\bSELECT\b/i,
    multiLinePattern: /\bINSERT\s+INTO\b[\s\S]{0,400}?\bSELECT\b/i,
  },
  {
    signal: 'bulk-insert-derived-rows',
    reason: 'queryInterface.bulkInsert( of derived rows',
    pattern: /queryInterface\.bulkInsert\(/,
  },
  {
    signal: 'delete-purge-rows',
    reason: 'raw DELETE FROM string literal or queryInterface.bulkDelete( purge',
    pattern: /['"`]DELETE\s+FROM|queryInterface\.bulkDelete\(/,
  },
];

// Multi-line family: a loop that loads existing rows and rewrites them
// (models.X.findAll() ... rec.update(...)). Detected at the up()-body
// level, not per line, because the two halves never share a line.
function hasSaveLoop(upBody) {
  return /\.findAll\(/.test(upBody) && /\.update\(/.test(upBody);
}

var SAVE_LOOP_SIGNAL = {
  signal: 'save-loop-existing-rows',
  reason: 'findAll + update loop rewriting existing rows',
};

// ---------------------------------------------------------------------------
// up() body extraction. The histories use a uniform module.exports = { up,
  // down } shape (function, arrow, and async variants); the body is the
  // slice between the up marker and the down marker.
// ---------------------------------------------------------------------------

function sliceUpBody(source) {
  var upMatch = source.match(/(^|[{,])\s*(async\s+)?up\s*[:=(]/m);
  if (!upMatch) {
    return { body: '', startLine: 1 };
  }
  var markerStart = upMatch.index + upMatch[1].length;
  var rest = source.slice(markerStart);
  var downMatch = rest.match(/\n\s*(async\s+)?down\s*[:=(]/);
  return {
    body: downMatch ? rest.slice(0, downMatch.index) : rest,
    startLine: (source.slice(0, markerStart).match(/\n/g) || []).length + 1,
  };
}

// Signals over arbitrary text (used for the delegate modules, whose whole
// purpose is the transform). Line-level for the per-line families so the
// failure message points at the offending code; the save-loop family is
// reported once against the line of its findAll( half.
function signalsInText(relativePath, text, startLine) {
  var found = [];
  var firstLine = startLine || 1;
  var lines = text.split('\n');
  var seenPerFamily = {};

  lines.forEach(function(line, index) {
    LINE_FAMILIES.forEach(function(family) {
      family.pattern.lastIndex = 0;
      if (family.pattern.test(line)) {
        seenPerFamily[family.signal] = true;
        found.push({
          file: relativePath,
          line: firstLine + index,
          signal: family.signal,
          text: line.trim(),
        });
      }
    });
  });

  // Continuation-line families: an INSERT INTO ... whose SELECT half sits
  // on the next source line (string-concatenated SQL). Detected over the
  // whole text once, reported against the family's opening line.
  LINE_FAMILIES.forEach(function(family) {
    if (!family.multiLinePattern || seenPerFamily[family.signal]) {
      return;
    }
    family.multiLinePattern.lastIndex = 0;
    var wholeMatch = text.match(family.multiLinePattern);
    if (wholeMatch) {
      var upToOpening = text.slice(0, wholeMatch.index);
      var openingIndex = (upToOpening.match(/\n/g) || []).length;
      found.push({
        file: relativePath,
        line: firstLine + openingIndex,
        signal: family.signal,
        text: lines[openingIndex].trim(),
      });
    }
  });

  if (hasSaveLoop(text)) {
    var lines = text.split('\n');
    var findAllIndex = lines.findIndex(function(line) {
      return /\.findAll\(/.test(line);
    });
    found.push({
      file: relativePath,
      line: firstLine + findAllIndex,
      signal: SAVE_LOOP_SIGNAL.signal,
      text: lines[findAllIndex].trim(),
    });
  }

  return found;
}

// Every signal a single up() body carries.
function signalsInUpBody(relativePath, source) {
  var sliced = sliceUpBody(source);
  if (!sliced.body) {
    return [];
  }
  return signalsInText(relativePath, sliced.body, sliced.startLine);
}

// ---------------------------------------------------------------------------
// The scan: every .js file in both histories.
// ---------------------------------------------------------------------------

function listJsFiles(absPath, into) {
  fs.readdirSync(absPath).forEach(function(child) {
    var childPath = path.join(absPath, child);
    if (fs.statSync(childPath).isDirectory()) {
      return; // histories are flat
    }
    if (path.extname(childPath) === '.js') {
      into.push(childPath);
    }
  });
}

function collectHistoryFiles(historyDir) {
  var abs = path.join(root, historyDir);
  var files = [];
  listJsFiles(abs, files);
  return files.map(function(abs) {
    return historyDir + '/' + path.basename(abs);
  }).sort();
}

function accountedSet() {
  var set = {};
  manifest.migrations.forEach(function(entry) {
    set[entry.migration] = entry;
  });
  return set;
}

// Offenders: signal-carrying migrations absent from the manifest. Pure
// (files, sources, accounted) -> offenders so the fabricated teeth can
// prove the contract on synthetic input without touching the real repo.
function offendersAmong(relativeFiles, readSource, accounted) {
  var offenders = [];
  relativeFiles.forEach(function(rel) {
    var signals = signalsInUpBody(rel, readSource(rel));
    if (!accounted[rel]) {
      signals.forEach(function(hit) {
        offenders.push(hit);
      });
    }
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

// Non-phantom validation. Pure (entries, fs-like) -> problems, so the teeth
// can fabricate entries without corrupting the real manifest on disk.
function phantomProblems(entries, exists, readSource) {
  var problems = [];

  entries.forEach(function(entry) {
    if (!entry.migration) {
      problems.push(JSON.stringify(entry) + ': entry without a migration path');
      return;
    }

    if (!exists(entry.migration)) {
      problems.push(entry.migration + ': file does not exist');
      return;
    }

    var historyDir = HISTORIES[entry.history];
    if (!historyDir) {
      problems.push(entry.migration + ': unknown history "' + entry.history + '" (core or portal)');
    } else if (entry.migration.indexOf(historyDir + '/') !== 0) {
      problems.push(
        entry.migration + ': history "' + entry.history + '" does not match the path prefix ' + historyDir + '/'
      );
    }

    if (!entry.transforms || !entry.transforms.trim()) {
      problems.push(entry.migration + ': empty transforms description');
    }

    if (entry.spec !== REPLAY_SPEC) {
      problems.push(
        entry.migration + ': spec must be exactly ' + REPLAY_SPEC + ' - the replay spec iterates this manifest'
      );
    }

    var signals = signalsInUpBody(entry.migration, readSource(entry.migration));

    if (entry.delegate) {
      if (!exists(entry.delegate)) {
        problems.push(entry.migration + ': delegate ' + entry.delegate + ' does not exist');
      } else {
        var delegateBasename = path.basename(entry.delegate).replace(/\.[^.]+$/, '');
        if (readSource(entry.migration).indexOf(delegateBasename) === -1) {
          problems.push(
            entry.migration + ': names delegate ' + entry.delegate + ' but never requires it - the delegation is a phantom'
          );
        }
        // The delegate module's whole source is the transform surface:
        // it is not a migration file and has no up()/down() pair.
        signals = signals.concat(signalsInText(entry.delegate, readSource(entry.delegate), 1));
      }
    }

    if (signals.length === 0) {
      problems.push(
        entry.migration
        + ': no transform signal in its up() body (or delegate) - it is pure DDL and must leave the manifest'
      );
    }
  });

  return problems;
}

describe('D-10 data-rewriting migration manifest (companion gate)', function() {

  var coreFiles = collectHistoryFiles(HISTORIES.core);
  var portalFiles = collectHistoryFiles(HISTORIES.portal);
  var accounted = accountedSet();
  var realRead = function(rel) {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  };
  var realExists = function(rel) {
    return fs.existsSync(path.join(root, rel));
  };
  var offenders = offendersAmong(coreFiles.concat(portalFiles), realRead, accounted);

  // (1) SURFACES-EXIST: both histories are scanned. A broken walk resolves
  // to nothing and the staleness contract below would be green for the
  // wrong reason (license_consistency / env_read_invariant guard). The
  // thresholds track the audited repo (34 core files, 5 portal files) with
  // headroom so a legitimate edit never trips them.
  it('has both migration histories to scan (surfaces-exist)', function() {
    expect(coreFiles.length, 'the core history walk resolved to too few files').to.be.above(30);
    expect(portalFiles.length, 'the portal history walk resolved to too few files').to.be.above(4);
  });

  it('has a non-empty manifest with only core or portal histories', function() {
    expect(
      manifest.migrations.length,
      'the manifest is empty - no data-rewriting migration would ever be replayed'
    ).to.be.above(0);
    manifest.migrations.forEach(function(entry) {
      expect(entry.history, entry.migration + ' history').to.be.oneOf(['core', 'portal']);
    });
  });

  // The portal history is all DDL today; its absence from the manifest is
  // an audited fact recorded in _comment, not an omission this gate would
  // paper over - which is exactly why the surfaces-exist guard above scans
  // that directory too.
  it('explains a history with zero entries in the manifest _comment', function() {
    var represented = {};
    manifest.migrations.forEach(function(entry) {
      represented[entry.history] = true;
    });

    Object.keys(HISTORIES).forEach(function(history) {
      if (represented[history]) {
        return;
      }
      expect(
        manifest._comment.indexOf(history),
        'history "' + history + '" has zero entries - the manifest _comment must explain why'
      ).to.not.equal(-1);
    });
  });

  // (2) RE-DERIVATION, the staleness contract itself. This is the spec
  // that fails the build when a data-rewriting migration appears outside
  // the manifest: it would never get an honest pre-state replay.
  it('has no transform-carrying migration outside the manifest', function() {
    expect(
      offenders,
      'these migrations rewrite rows in their up() but are NOT in t/fixtures/data-rewriting-migrations.json - the manifest has gone stale; add them (with an honest transforms description) or reclassify:\n'
        + format(offenders)
    ).to.be.an('array').with.lengthOf(0);
  });

  // (3) NON-PHANTOM: every entry's migration exists, belongs to its named
  // history, carries a detector-visible signal in its up() body or its
  // delegate, and points at the replay spec. The manifest cannot list
  // phantoms.
  it('has no phantom entries (file, history, signal, delegate verified)', function() {
    var problems = phantomProblems(manifest.migrations, realExists, realRead);
    expect(
      problems,
      'these manifest entries are phantoms - the file, its history, its transform signal, or its delegate is gone:\n'
        + problems.join('\n')
    ).to.be.an('array').with.lengthOf(0);
  });

  // (3b) NON-VACUOUS: the re-derivation and the manifest must actually
  // overlap - at least one entry is self-signaled in its own up() body
  // (oem_no_vendor_leak allowlist-non-vacuous shape). If every entry
  // qualified only through a delegate, the up()-body detector would be
  // guarding a list it can never see.
  it('has self-signaled entries the up()-body detector can actually see', function() {
    var selfSignaled = manifest.migrations.filter(function(entry) {
      return signalsInUpBody(entry.migration, realRead(entry.migration)).length > 0;
    });
    expect(
      selfSignaled.length,
      'no manifest entry carries a detector-visible signal in its own up() body - the scan and the manifest have nothing in common'
    ).to.be.above(0);
  });

  // (4) POSITIVE TEETH: the detector flags a synthetic snippet from every
  // signal family, including the families with zero unaccounted carriers
  // today (raw UPDATE, bulkDelete) - the first thing the next
  // data-rewriting migration will reach for.
  it('flags a synthetic snippet from every signal family', function() {
    var syntheticUp = [
      'up: function(queryInterface, Sequelize) {',
      "  return queryInterface.bulkUpdate('Companies', {a: 1}, {id: 2});",        // bulk-update-rows
      "  await sequelize.query(\"UPDATE `Companies` SET a = 1 WHERE id = 2\");",   // raw-update-statement
      "  await sequelize.query('INSERT INTO `T_backup` (id) SELECT id FROM `T`');", // insert-select-backfill
      "  return queryInterface.bulkInsert('BankHolidays', rows);",                // bulk-insert-derived-rows
      "  await sequelize.query('DELETE FROM `audit` WHERE attribute IN (?,?,?)');", // delete-purge-rows
      '  const records = await models.EmailAudit.findAll();',                     // save-loop half 1
      '  return records.forEach(rec => rec.update({body: text(rec.body)}));',     // save-loop half 2
      '},',
      'down: function() {}',
    ].join('\n');

    var hits = signalsInUpBody('migrations/__synthetic__.js', syntheticUp);
    var seen = {};
    hits.forEach(function(hit) {
      seen[hit.signal] = true;
    });

    LINE_FAMILIES.concat([SAVE_LOOP_SIGNAL]).forEach(function(family) {
      expect(
        seen[family.signal],
        'the detector failed to flag the synthetic ' + family.signal + ' snippet - the family is blind'
      ).to.equal(true);
    });
  });

  // (5) NEGATIVE TEETH: an up() doing only DDL through Sequelize's
  // dialect-abstracted API is NOT flagged - the audit criterion is rows,
  // not schema. A false positive here forces a manifest entry with no
  // honest reason.
  it('does not flag pure-DDL up() bodies', function() {
    var pureDdl = [
      'up: function(queryInterface, Sequelize) {',
      '  return queryInterface.describeTable("Companies").then(attributes => {',
      '    if (attributes.hasOwnProperty("mode")) { return 1; }',
      '    return queryInterface.addColumn("Companies", "mode", {type: Sequelize.STRING});',
      '  });',
      '},',
      'down: function(queryInterface) {',
      '  return queryInterface.removeColumn("Companies", "mode");',
      '},',
    ].join('\n');

    var hits = signalsInUpBody('migrations/__ordinary__.js', pureDdl);
    expect(
      hits,
      'a pure-DDL up() was flagged - the detector is too broad, it would force pointless manifest entries:\n'
        + format(hits)
    ).to.be.an('array').with.lengthOf(0);
  });

  // (5b) The down() exclusion is load-bearing, not an accident: several
  // up()'s have down() bodies that reverse row rewrites (the localization
  // migration's down bulkUpdates names back to English), and flagging
  // those would list migrations whose UPGRADE path never touches a row.
  // The audit criterion is the up() body.
  it('never reads signals from the down() body', function() {
    var downOnly = [
      'up: function(queryInterface, Sequelize) {',
      '  return queryInterface.addColumn("Companies", "mode", Sequelize.STRING);',
      '},',
      'down: function(queryInterface, Sequelize) {',
      "  return queryInterface.bulkUpdate('Companies', {name: 'English'}, {id: 1});",
      '},',
    ].join('\n');

    var hits = signalsInUpBody('migrations/__down_only__.js', downOnly);
    expect(
      hits,
      'a down()-only rewrite was flagged - the detector must scan the up() body only:\n'
        + format(hits)
    ).to.be.an('array').with.lengthOf(0);
  });

  // (6) FABRICATED OUT-OF-MANIFEST SCENARIO: the staleness contract really
  // does fail a migration that is not in the manifest. Proven on synthetic
  // input fed through the same offender filter the real scan uses, not by
  // corrupting the real manifest on disk (05-04 shape).
  it('fails a fabricated out-of-manifest transform carrier', function() {
    var fabricatedPath = 'migrations/__fabricated_data_rewrite__.js';
    var fabricatedSource = [
      'up: function(queryInterface, Sequelize) {',
      "  return queryInterface.sequelize.query('DELETE FROM `audit` WHERE attribute = \'password\'');",
      '},',
      'down: function() {}',
    ].join('\n');

    // Sanity: the fabricated path really is outside the manifest,
    // otherwise this teeth proves nothing.
    expect(accounted[fabricatedPath], 'the fabricated path must not be a manifest entry').to.not.equal(true);

    var hits = offendersAmong([fabricatedPath], function() {
      return fabricatedSource;
    }, accounted);
    expect(
      hits.map(function(o) {
        return o.file + ' [' + o.signal + ']';
      }),
      'a transform-carrying migration outside the manifest must become an offender naming the file and the signal'
    ).to.deep.equal([fabricatedPath + ' [delete-purge-rows]']);

    // And the mirror: the same source accounted for in the manifest
    // produces no offender - the contract fails on absence, not on the
    // signal itself.
    var accountedFor = offendersAmong([fabricatedPath], function() {
      return fabricatedSource;
    }, (function() {
      var set = Object.assign({}, accounted);
      set[fabricatedPath] = {};
      return set;
    })());
    expect(accountedFor, 'an accounted-for transform carrier must not be an offender').to.be.an('array').with.lengthOf(0);
  });

  // (7) FABRICATED PHANTOM SCENARIO: a manifest entry whose up() carries
  // no signal (pure DDL), or whose delegate does not exist / is never
  // required, is rejected. Pure phantomProblems() application over
  // synthetic entries and an in-memory filesystem.
  it('rejects fabricated phantom entries', function() {
    var files = {
      'migrations/__real_ddl__.js': 'module.exports = { up: (qi) => qi.addColumn("C", "x", {}), down: () => {} };',
      'migrations/__delegating__.js': 'const delegate = require(\'../lib/__delegate__\');\nmodule.exports = { up: () => delegate.apply({}), down: () => {} };',
      'lib/__delegate__.js': 'module.exports = { apply: () => queryInterface.bulkUpdate("C", {}, {}) };',
    };
    var exists = function(rel) {
      return Object.prototype.hasOwnProperty.call(files, rel);
    };
    var read = function(rel) {
      return files[rel];
    };

    var problems = phantomProblems([
      {migration: 'migrations/__missing__.js', history: 'core', transforms: 'x', spec: REPLAY_SPEC},
      {migration: 'migrations/__real_ddl__.js', history: 'core', transforms: 'x', spec: REPLAY_SPEC},
      {migration: 'migrations/__real_ddl__.js', history: 'portal', transforms: 'x', spec: REPLAY_SPEC},
      {migration: 'migrations/__real_ddl__.js', history: 'core', transforms: '  ', spec: REPLAY_SPEC},
      {
        migration: 'migrations/__delegating__.js',
        history: 'core',
        transforms: 'x',
        spec: REPLAY_SPEC,
        delegate: 'lib/__missing_delegate__.js',
      },
      {
        migration: 'migrations/__delegating__.js',
        history: 'core',
        transforms: 'x',
        spec: 't/unit/__elsewhere__.js',
        delegate: 'lib/__delegate__.js',
      },
    ], exists, read);

    var joined = problems.join('\n');
    // One problem for the missing file; one for the pure-DDL entry; two for
    // the wrong history (prefix mismatch + no signal); two for the empty
    // transforms (empty + no signal); two for the missing delegate (missing
    // + no signal); one for the wrong spec (the good delegate carries the
    // signal, so only the spec contract fails).
    expect(problems, 'every fabricated phantom shape must be named:\n' + joined).to.have.lengthOf(9);
    expect(joined).to.contain('__missing__.js: file does not exist');
    expect(joined).to.contain('migrations/__real_ddl__.js: no transform signal');
    expect(joined).to.contain('does not match the path prefix portal/migrations/');
    expect(joined).to.contain('empty transforms description');
    expect(joined).to.contain('delegate lib/__missing_delegate__.js does not exist');
    expect(joined).to.contain('spec must be exactly ' + REPLAY_SPEC);
    // And the honest shape produces no problems at all.
    expect(
      phantomProblems([{
        migration: 'migrations/__delegating__.js',
        history: 'core',
        transforms: 'rewrites rows',
        spec: REPLAY_SPEC,
        delegate: 'lib/__delegate__.js',
      }], exists, read),
      'a well-formed delegated entry must pass cleanly'
    ).to.have.lengthOf(0);
  });

  // (8) DETERMINISTIC ORDERING: file, then numeric line, then signal -
  // not lexicographic on the formatted string (BRAND-02 ordering edge:
  // line 2 must sort before line 10).
  it('orders offenders file-then-line deterministically', function() {
    var sources = {
      'migrations/__b__.js': "up: function (queryInterface) { return queryInterface.bulkUpdate('C', {}, {}); },\ndown: function () {}",
      'migrations/__a__.js': [
        'up: function (queryInterface) {',
        "  return queryInterface.sequelize.query('INSERT INTO `X` (id) SELECT id FROM `Y`');",
        '},',
        'down: function () {}',
      ].join('\n'),
    };

    var hits = offendersAmong(['migrations/__b__.js', 'migrations/__a__.js'], function(rel) {
      return sources[rel];
    }, {});
    expect(
      hits.map(function(o) {
        return o.file + ':' + o.line;
      }),
      'offenders must sort file-first with numeric lines, not string order'
    ).to.deep.equal(['migrations/__a__.js:2', 'migrations/__b__.js:1']);
  });
});
