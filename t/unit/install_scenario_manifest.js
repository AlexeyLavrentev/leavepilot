'use strict';

/*
  Install-check companion gate (06-01; INSTALL-02, D-02/D-05/D-08): the
  scenario map cannot go stale silently.

  bin/install_check.js executes bash blocks taken from the install docs
  at run time; t/fixtures/install-scenario.json is the map that says
  which blocks the scenario runs and which are excluded with a reason.
  A static map like that rots in two directions, both silently:

  - an ORPHAN doc block: someone adds a bash fence to a covered section
    (or renames a heading) and no scenario step or exclusion accounts
    for it - the doc changed, the install gate never noticed;
  - a PHANTOM step: the map points at a (doc, heading, blockIndex) that
    no longer resolves - the runner would fail at run time, but CI runs
    the gate only on the install job; this spec makes it fail every
    unit-suite run too, and with a message naming the step.

  This spec re-derives the bash-fence inventory of the covered docs
  with the SAME scanner the runner uses (parseDocFences exported from
  bin/install_check.js - one scanner, not a second opinion) and
  cross-checks it against the fixture in both directions. From 06-02
  the covered surface is BOTH install docs: docs/docker-compose.md
  (full stranger path) and docs/install-local-npm.md (the variant-A
  fast slice, D-07).

  Modeled on t/unit/dialect_sensitive_manifest.js (the six-part
  companion-gate anatomy: surfaces-exist, staleness, non-phantom,
  non-vacuous, synthetic teeth, determinism) which is itself modeled
  on t/unit/oem_no_vendor_leak.js §6 and t/unit/env_read_invariant.js.

  The D-08 boundary lives here too: the fixture may reference exactly
  the two install docs (docs/docker-compose.md now,
  docs/install-local-npm.md from plan 06-02) - any other doc path in a
  step or exclusion fails, so the "docs do not lie" invariant cannot
  silently grow a third surface.

  Synthetic teeth feed fabricated doc strings through the SAME pure
  accounting function the real scan uses - the real fixture and the
  real docs are never mutated on disk.
*/

var expect = require('chai').expect;
var fs = require('fs');
var path = require('path');

var scanner = require('../../bin/install_check');

var root = path.join(__dirname, '..', '..');
var fixture = JSON.parse(
  fs.readFileSync(path.join(root, 't', 'fixtures', 'install-scenario.json'), 'utf8')
);

// D-08: the invariant covers exactly the two install docs.
var ALLOWED_DOCS = [
  'docs/docker-compose.md',
  'docs/install-local-npm.md',
];

// D-07 reason discipline for the second install doc: every exclusion of
// docs/install-local-npm.md is by definition a block outside the
// variant-A fast subset (variant B/C external MySQL/Redis, post-upgrade
// advice) - the boundary decision itself is the justification, so the
// reason must name D-07 the same way D-05 boundary sections must name
// D-05.
var D07_DOC = 'docs/install-local-npm.md';

// D-05 coverage boundary: exclusions of blocks in these sections (by
// heading substring) must name D-05 in their reason - the boundary
// decision itself is the justification for the exclusion.
var D05_HEADING_MARKERS = [
  'Commercial',
  'reminder',
  'Проверка сессий',
  'Docker Compose для разработки',
  'Диагностика',
];

function docSource(relativeDoc) {
  return fs.readFileSync(path.join(root, relativeDoc), 'utf8');
}

function bashBlocksOf(relativeDoc) {
  return scanner.parseDocFences(docSource(relativeDoc)).filter(function(block) {
    return block.lang === 'bash';
  });
}

// Every doc the fixture references (steps and exclusions alike).
function referencedDocs(map) {
  var docs = {};
  sliceDocSteps(map).concat(map.exclusions || []).forEach(function(entry) {
    docs[entry.doc] = true;
  });
  return Object.keys(docs).sort();
}

function sliceDocSteps(map) {
  var steps = [];
  Object.keys(map.slices || {}).forEach(function(name) {
    (map.slices[name] || []).forEach(function(step) {
      if (step.doc) {
        steps.push(step);
      }
    });
  });
  return steps;
}

function accountingKey(doc, heading, blockIndex) {
  return doc + ' :: ' + heading + ' :: bash#' + blockIndex;
}

function blockKey(doc, block) {
  return accountingKey(doc, block.heading, block.blockIndex);
}

// The set of (doc, heading, blockIndex) the scenario accounts for -
// executed steps plus reasoned exclusions.
function accountedSet(map) {
  var set = {};
  sliceDocSteps(map).concat(map.exclusions || []).forEach(function(entry) {
    set[accountingKey(entry.doc, entry.heading, entry.blockIndex)] = true;
  });
  return set;
}

// Pure: which parsed bash blocks are accounted for by nothing. The same
// filter the real scan and the synthetic teeth both go through.
function unaccountedBlocks(doc, blocks, accounted) {
  return blocks.filter(function(block) {
    return !accounted[blockKey(doc, block)];
  });
}

function formatUnaccounted(doc, blocks) {
  return blocks.map(function(block) {
    return doc + ' :: "' + block.heading + '" :: bash#' + block.blockIndex
      + ' (doc line ' + block.line + ')';
  }).join('\n');
}

// The same resolution the runner performs: a step is real when a bash
// fence with its (heading, per-language blockIndex) exists in its doc.
function resolveStep(step) {
  return bashBlocksOf(step.doc).filter(function(block) {
    return block.heading === step.heading && block.blockIndex === step.blockIndex;
  })[0] || null;
}

describe('install scenario manifest (companion gate, 06-01)', function() {

  var dockerBlocks = bashBlocksOf('docs/docker-compose.md');
  var accounted = accountedSet(fixture);

  // (1) SURFACES-EXIST: a scan whose input resolves to nothing is green
  // for the wrong reason. The docker-compose doc carries 20+ bash
  // fences today; the threshold is modest so a legitimate doc edit
  // never trips it, while a broken scanner or an emptied doc does. The
  // empty-input teeth proves the count comes from the parse, not from
  // a hardcoded answer: an empty source must yield zero blocks through
  // the same function.
  it('has a real bash-fence surface to guard (surfaces-exist)', function() {
    expect(
      dockerBlocks.length,
      'docs/docker-compose.md resolved to too few bash fences - the scanner lost its input'
    ).to.be.above(15);

    referencedDocs(fixture).forEach(function(doc) {
      var count = bashBlocksOf(doc).length;
      expect(
        count,
        'referenced doc ' + doc + ' resolved to too few bash fences'
      ).to.be.above(4);
    });

    expect(
      scanner.parseDocFences('').length,
      'an empty parse input must yield zero fences - otherwise surfaces-exist is vacuous'
    ).to.equal(0);
    expect(
      scanner.parseDocFences('# Heading\n\n```text\nnothing executable\n```\n').length,
      'a doc with no bash fences must yield zero bash candidates'
    ).to.equal(1); // the fence exists but is text; bashBlocksOf filters it

    // The second install doc joined the invariant with 06-02 (D-07); its
    // bash surface is guarded unconditionally, not only once referenced.
    expect(
      bashBlocksOf('docs/install-local-npm.md').length,
      'docs/install-local-npm.md resolved to too few bash fences - the scanner lost its input'
    ).to.be.above(5);
  });

  // (2) STALENESS, the contract itself: every bash block of BOTH covered
  // docs is either a scenario step or an exclusion with a reason. This
  // is the test that fails the build when a bash fence appears in a
  // covered section and nobody maps it. The doc list is ALLOWED_DOCS,
  // not "whatever the fixture references" - an install doc nobody maps
  // yet is exactly the orphan state this gate exists to catch, so the
  // contract must hold for the second doc even before the fixture's
  // first step points at it.
  it('has no orphan bash block outside the scenario map and its exclusions', function() {
    ALLOWED_DOCS.forEach(function(relativeDoc) {
      var offenders = unaccountedBlocks(relativeDoc, bashBlocksOf(relativeDoc), accounted);

      expect(
        formatUnaccounted(relativeDoc, offenders).trim(),
        'these bash blocks of ' + relativeDoc + ' are neither scenario steps nor reasoned'
          + ' exclusions in t/fixtures/install-scenario.json - the map has gone stale; map them'
          + ' (with an honest reason) or extend the scenario:\n'
          + formatUnaccounted(relativeDoc, offenders)
      ).to.equal('');
    });
  });

  // (3) NON-PHANTOM: every step and every exclusion resolves to a real
  // bash fence; every doc step pins its expectCommand literal (the
  // runner's drift teeth are only armed when the literal is present);
  // every exclusion carries a substantive reason, and exclusions inside
  // the D-05 boundary sections name D-05.
  it('has no phantom steps or exclusions (every reference resolves)', function() {
    var phantoms = [];

    sliceDocSteps(fixture).forEach(function(step) {
      if (!resolveStep(step)) {
        phantoms.push(accountingKey(step.doc, step.heading, step.blockIndex)
          + ': resolves to no bash fence');
      }
      if (!step.expectCommand || typeof step.expectCommand !== 'string') {
        phantoms.push(accountingKey(step.doc, step.heading, step.blockIndex)
          + ': no expectCommand literal - the runner could not pin it against doc drift');
      }
    });

    (fixture.exclusions || []).forEach(function(entry) {
      if (!resolveStep(entry)) {
        phantoms.push(accountingKey(entry.doc, entry.heading, entry.blockIndex)
          + ' (exclusion): resolves to no bash fence');
      }
      if (!entry.reason || entry.reason.length < 20) {
        phantoms.push(accountingKey(entry.doc, entry.heading, entry.blockIndex)
          + ' (exclusion): no substantive reason');
      }
      var inD05Section = D05_HEADING_MARKERS.some(function(marker) {
        return entry.heading.indexOf(marker) !== -1;
      });
      if (inD05Section && entry.reason.indexOf('D-05') === -1) {
        phantoms.push(accountingKey(entry.doc, entry.heading, entry.blockIndex)
          + ' (exclusion): a block outside the D-05 community coverage must name D-05 in its reason');
      }
      if (entry.doc === D07_DOC && entry.reason.indexOf('D-07') === -1) {
        phantoms.push(accountingKey(entry.doc, entry.heading, entry.blockIndex)
          + ' (exclusion): a block outside the variant-A fast subset must name D-07 in its reason');
      }
    });

    expect(
      phantoms,
      'these fixture entries are phantoms - the doc block, the reason, or the pin is gone:\n'
        + phantoms.join('\n')
    ).to.deep.equal([]);
  });

  // (3b) D-08 BOUNDARY: the fixture references exactly the two install
  // docs. Any other doc path in a step or an exclusion fails - the
  // invariant cannot silently grow a third surface.
  it('references only the two install docs (D-08 boundary)', function() {
    var outside = referencedDocs(fixture).filter(function(doc) {
      return ALLOWED_DOCS.indexOf(doc) === -1;
    });

    expect(
      outside,
      'the install-check invariant covers exactly docs/docker-compose.md and'
        + ' docs/install-local-npm.md (D-08); these paths are out of boundary:\n'
        + outside.join('\n')
    ).to.deep.equal([]);
  });

  // (4) NON-VACUOUS: the docker slice still proves what INSTALL-01
  // demands - boot, first admin, login, teardown. A gutted map (someone
  // deleting "just a step") must fail here, not pass quietly.
  it('has a non-vacuous docker slice (boot, admin, login, cleanup)', function() {
    var dockerSlice = (fixture.slices || {}).docker || [];

    var hasBoot = dockerSlice.some(function(step) {
      return step.expectCommand === 'docker compose up --build -d';
    });
    var hasCleanup = dockerSlice.some(function(step) {
      return step.role === 'cleanup' && step.expectCommand === 'docker compose down -v';
    });
    var hasAdmin = dockerSlice.some(function(step) {
      return step.harness === 'register_first_admin';
    });
    var hasLogin = dockerSlice.some(function(step) {
      return step.harness === 'login_first_admin';
    });

    expect(hasBoot, 'the docker slice no longer boots the stack (docker compose up --build -d)').to.equal(true);
    expect(hasAdmin, 'the docker slice no longer creates the first admin (D-03)').to.equal(true);
    expect(hasLogin, 'the docker slice no longer logs in (D-03)').to.equal(true);
    expect(hasCleanup, 'the docker slice no longer tears the stand down (docker compose down -v)').to.equal(true);
    expect(dockerSlice.length, 'the docker slice is suspiciously small').to.be.above(8);
  });

  // (4b) NON-VACUOUS npm slice (06-02, D-07): the cheap proof over the
  // second install doc - dependencies from the doc's own block, migrations
  // BEFORE the boot, the server started in the background (await:false -
  // it must not block the scenario), the harness readiness wait, the
  // SQLite dialect assert, and the background server stopped by name. A
  // gutted npm slice must fail here, not pass quietly.
  it('has a non-vacuous npm slice (install, migrate, background boot, sqlite check, stop)', function() {
    var npmSlice = (fixture.slices || {}).npm || [];

    var firstIndex = function(predicate) {
      for (var i = 0; i < npmSlice.length; i += 1) {
        if (predicate(npmSlice[i])) {
          return i;
        }
      }
      return -1;
    };

    var install = firstIndex(function(step) { return step.expectCommand === 'npm install'; });
    var migrate = firstIndex(function(step) { return step.expectCommand === 'npm run db-update'; });
    var boot = firstIndex(function(step) {
      return step.expectCommand === 'npm start' && step.await === false;
    });
    var ready = firstIndex(function(step) { return step.harness === 'wait_http_302'; });
    var dialect = firstIndex(function(step) { return step.harnessAssert === 'sqlite_dialect'; });
    var stop = firstIndex(function(step) { return step.harness === 'stop_background_steps'; });

    expect(npmSlice.length, 'the npm slice is suspiciously small').to.be.above(4);
    expect(install, 'the npm slice no longer installs dependencies from the doc block').to.be.at.least(0);
    expect(migrate, 'the npm slice no longer applies migrations (npm run db-update)').to.be.at.least(0);
    expect(boot, 'the npm slice no longer boots the app in the background (npm start, await:false)').to.be.at.least(0);
    expect(ready, 'the npm slice no longer waits for HTTP 302 readiness').to.be.at.least(0);
    expect(dialect, 'the npm slice no longer asserts the SQLite dialect from the doc block').to.be.at.least(0);
    expect(stop, 'the npm slice no longer stops the background server').to.be.at.least(0);

    // The doc's own order is the contract (D-02): migrations run BEFORE
    // the boot so the server starts on an applied schema; readiness
    // precedes the dialect check so it runs against a live install; the
    // background stop is the last thing the slice does.
    expect(migrate, 'migrations must run before the background boot').to.be.below(boot);
    expect(boot, 'the background boot must precede the readiness wait').to.be.below(ready);
    expect(ready, 'the readiness wait must precede the dialect check').to.be.below(dialect);
    expect(dialect, 'the dialect check must precede the background stop').to.be.below(stop);

    // Single-doc slice: every doc step of the npm slice comes from
    // docs/install-local-npm.md - the runner's --doc override contract
    // (one referenced doc per slice) depends on it.
    npmSlice.forEach(function(step) {
      if (step.doc) {
        expect(step.doc, 'the npm slice executes only docs/install-local-npm.md (D-07/D-08)').to.equal('docs/install-local-npm.md');
      }
    });
  });

  // (5) SYNTHETIC TEETH: the accounting really does flag an out-of-map
  // block and pass a mapped one. Proven on a fabricated doc snippet fed
  // through the same parse+filter the real scan uses - the real doc and
  // the real fixture are never mutated on disk.
  it('flags a fabricated out-of-map block and passes a mapped one (teeth)', function() {
    var fabricatedDoc = [
      '## Подготовка',
      '',
      '```bash',
      'cp .env.example .env',
      '```',
      '',
      '## Новая секция',
      '',
      '```bash',
      'docker compose exec app some-new-check',
      '```',
      '',
    ].join('\n');

    var blocks = scanner.parseDocFences(fabricatedDoc).filter(function(block) {
      return block.lang === 'bash';
    });

    var onlyPrepAccounted = {};
    onlyPrepAccounted['docs/__fabricated__.md :: Подготовка :: bash#0'] = true;

    var offenders = unaccountedBlocks('docs/__fabricated__.md', blocks, onlyPrepAccounted);
    expect(
      offenders.map(function(block) { return block.heading + ' bash#' + block.blockIndex; }),
      'an unmapped bash block in a covered doc must become an offender naming heading + index'
    ).to.deep.equal(['Новая секция bash#0']);

    var bothAccounted = Object.assign({}, onlyPrepAccounted, {
      'docs/__fabricated__.md :: Новая секция :: bash#0': true,
    });
    expect(
      unaccountedBlocks('docs/__fabricated__.md', blocks, bothAccounted),
      'a mapped block must not be an offender - the contract fails on absence, not on presence'
    ).to.deep.equal([]);
  });

  // (6) DETERMINISM: block enumeration is stable across parses and
  // ordered doc -> heading -> index, so a failure message names the
  // same block on every machine and every run.
  it('enumerates blocks deterministically (doc -> heading -> index)', function() {
    var first = scanner.parseDocFences(docSource('docs/docker-compose.md'));
    var second = scanner.parseDocFences(docSource('docs/docker-compose.md'));

    expect(second, 'two parses of the same doc must produce identical block lists').to.deep.equal(first);

    // Within one heading, per-language indices ascend with document
    // order - the runner resolves by (heading, index), so a scanner
    // that numbered blocks backwards would silently swap steps.
    var byHeading = {};
    first.forEach(function(block) {
      var key = block.heading + '\u0000' + block.lang;
      byHeading[key] = (byHeading[key] || []).concat(block);
    });
    Object.keys(byHeading).forEach(function(key) {
      var group = byHeading[key];
      var indices = group.map(function(block) { return block.blockIndex; });
      var sorted = indices.slice().sort(function(a, b) { return a - b; });
      var lines = group.map(function(block) { return block.line; });
      var sortedLines = group.slice().sort(function(a, b) { return a.blockIndex - b.blockIndex; })
        .map(function(block) { return block.line; });
      expect(indices, 'blockIndex within a heading must be 0..n-1').to.deep.equal(sorted);
      expect(lines, 'higher blockIndex must mean a later doc line').to.deep.equal(sortedLines);
    });

    // Multi-doc enumeration is ordered by doc path first.
    var referenced = referencedDocs(fixture);
    expect(referenced, 'referenced docs enumerate in path order').to.deep.equal(referenced.slice().sort());
  });
});
