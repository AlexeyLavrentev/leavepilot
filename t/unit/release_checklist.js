'use strict';

/*
  Release-checklist teeth (06-06; REL-01, D-16/D-17, T-06-12/T-06-13) - the
  checklist cannot rot silently.

  docs/release-checklist.md is the paper a stranger auditor (and the owner at
  tag time) walks. It names CI jobs, env names, a version, and release
  surfaces; every one of those axes has already rotted once (TIMEOFF_* envs,
  2.1.0 versions, a stale uuid/Sequelize advisory, premium-first order). D-17
  additionally hangs the "walked in full" proof (REL-01) on the checklist's
  marks being mechanically honest: an [авто: <job>] mark that names a job id
  which does not exist in any workflow is a lie that reads like a check.

  This spec re-derives the checklist's contract from the repo itself:

  - deprecated env literals (TIMEOFF_) and foreign version tokens are failed
    against package.json's own version - the ONLY version a checklist for
    this repo may carry;
  - every [авто: <job>] mark must resolve to a job key that really exists in
    .github/workflows/*.yml (job ids are collected by the same hand-rolled
    text scan as t/unit/ci_install_commands.js - no yaml dependency);
  - the surfaces the phase shipped must stay named: the install gates, the
    mysql-dialect job, npm run screenshots (D-15), the LEGAL-11 inventory
    and its lawyer-verdict syft follow-up, cosign verification, the EN
    GitHub Release notes (D-19);
  - the release act stays community-only (D-20): no portal/premium job may
    appear as a release gate, and premium stays a scoped "after the
    community release" section (D-16).

  Teeth run on fabricated checklist strings fed through the SAME pure
  detectors the real scan uses - the real doc and the real workflows are
  read, never written.

  Companion-gate anatomy follows t/unit/install_scenario_manifest.js and
  t/unit/dialect_sensitive_manifest.js.
*/

const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const CHECKLIST_PATH = path.join(REPO_ROOT, 'docs', 'release-checklist.md');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');
const PACKAGE_VERSION = require(path.join(REPO_ROOT, 'package.json')).version;

// The deprecated generation-1 env prefix (02-01 D-15): canonical is
// LEAVEPILOT_*. A checklist line naming TIMEOFF_* teaches the operator the
// dead name at the exact moment they copy-paste config for a release.
const DEPRECATED_ENV = /TIMEOFF_/;

// x.y.z version tokens. The checklist may carry exactly one version: the
// package.json version (with or without the leading v of a git tag). Every
// other dotted triple is a fossil from an older release.
const VERSION_TOKEN = /\d+\.\d+\.\d+/g;

// [авто: <job-id>] marks. Job ids are [A-Za-z0-9_.-]+ like the keys under
// jobs: in the workflow files.
const AUTO_MARK = /\[авто:\s*([A-Za-z0-9_.-]+)\]/g;

// [руки] owner-action marks.
const RUKI_MARK = /\[руки\]/g;

function scanLines(source, pattern) {
  const hits = [];
  source.split('\n').forEach((line, index) => {
    if (pattern.test(line)) {
      hits.push({line: index + 1, match: line.trim()});
    }
    pattern.lastIndex = 0; // defensive: reset global regexes
  });
  return hits;
}

function findDeprecatedEnvLiterals(source) {
  return scanLines(source, DEPRECATED_ENV);
}

function findForeignVersionTokens(source, allowedVersion) {
  const foreign = [];
  source.split('\n').forEach((line, index) => {
    const tokens = line.match(VERSION_TOKEN) || [];
    tokens.forEach(token => {
      const bare = token.replace(/^v/, '');
      if (bare !== allowedVersion) {
        foreign.push({line: index + 1, match: token, context: line.trim()});
      }
    });
  });
  return foreign;
}

function parseAutoMarks(source) {
  const marks = [];
  source.split('\n').forEach((line, index) => {
    const re = new RegExp(AUTO_MARK.source, 'g');
    let match;
    while ((match = re.exec(line)) !== null) {
      marks.push({line: index + 1, job: match[1], match: match[0]});
    }
  });
  return marks;
}

function findPhantomJobMarks(marks, knownJobIds) {
  const known = new Set(knownJobIds);
  return marks.filter(mark => !known.has(mark.job));
}

// D-20: the community release act gates on community jobs only. The portal
// image build and any premium publish job are vendor-internal surfaces and
// may never appear as a release-checklist mark.
function findCommunityBoundaryViolations(marks) {
  return marks.filter(mark => /portal|premium/.test(mark.job));
}

function collectWorkflowFiles(dir) {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const target = path.join(dir, entry.name);
    return entry.isDirectory() ? collectWorkflowFiles(target) : [target];
  }).filter(file => file.endsWith('.yml') || file.endsWith('.yaml')).sort();
}

function collectWorkflowSources() {
  return collectWorkflowFiles(WORKFLOWS_DIR).map(file => ({
    file: path.relative(REPO_ROOT, file),
    source: fs.readFileSync(file, 'utf8'),
  }));
}

// Job ids = the two-space-indented `key:` lines directly under a column-0
// `jobs:` header, until the next column-0 key. Job properties (runs-on,
// steps, strategy...) sit at four spaces and deeper, and run-block bodies in
// these workflows never dip back to exactly two spaces, so the scan cannot
// pick up script lines. Same hand-rolled approach as ci_install_commands.js
// - no yaml dependency (plan prohibition).
function collectJobIds(workflowSources) {
  const jobIds = [];
  workflowSources.forEach(({file, source}) => {
    let inJobs = false;
    source.split('\n').forEach(line => {
      if (/^\S/.test(line)) {
        inJobs = /^jobs:\s*$/.test(line);
        return;
      }
      if (!inJobs) {
        return;
      }
      const match = line.match(/^ {2}([A-Za-z0-9_.-]+):\s*(?:#.*)?$/);
      if (match) {
        jobIds.push(match[1]);
      }
    });
  });
  return jobIds.sort();
}

describe('Release checklist teeth (06-06, D-16/D-17)', function() {
  const checklist = fs.readFileSync(CHECKLIST_PATH, 'utf8');
  const workflowSources = collectWorkflowSources();
  const knownJobIds = collectJobIds(workflowSources);
  const autoMarks = parseAutoMarks(checklist);

  it('has a real surface to guard (checklist + workflows + job-id collector)', function() {
    expect(checklist.length, 'docs/release-checklist.md must exist and be non-trivial')
      .to.be.at.least(500);

    expect(
      workflowSources.map(source => source.file),
      'the CI workflows live in .github/workflows and must stay scannable'
    ).to.include('.github/workflows/core-ci.yml');

    // The collector must see the jobs the release act marks: proves the
    // resolution below is anchored in reality, not in an empty set.
    [
      'dco', 'test', 'docker-build', 'mysql-migration-smoke', 'install-docker',
      'install-npm', 'mysql-dialect', 'security', 'integration', 'prepare',
      'build', 'merge',
    ].forEach(jobId => {
      expect(knownJobIds, 'job-id collector must find ' + jobId + ' in the workflows')
        .to.include(jobId);
    });
  });

  it('carries zero TIMEOFF_* literals and zero version tokens besides ' + PACKAGE_VERSION, function() {
    const envHits = findDeprecatedEnvLiterals(checklist);
    expect(
      envHits.map(hit => hit.line + ' -> ' + hit.match),
      'canonical env generation is LEAVEPILOT_* (02-01 D-15); a release checklist'
        + ' teaching TIMEOFF_* ships the dead name to every operator'
    ).to.deep.equal([]);

    const foreignVersions = findForeignVersionTokens(checklist, PACKAGE_VERSION);
    expect(
      foreignVersions.map(hit => hit.line + ' -> ' + hit.match + ' in "' + hit.context + '"'),
      'the checklist may name exactly one version - the package.json version '
        + PACKAGE_VERSION + '; any other dotted triple is a stale-release fossil'
    ).to.deep.equal([]);
  });

  it('marks items with real auto/ruki marks and every auto mark resolves to an existing CI job', function() {
    expect(
      autoMarks.length,
      'D-17 requires real coverage, not token presence: at least 8 [авто:] marks'
    ).to.be.at.least(8);

    const rukiCount = (checklist.match(RUKI_MARK) || []).length;
    expect(
      rukiCount,
      'D-17 requires real owner coverage: at least 4 [руки] marks'
    ).to.be.at.least(4);

    const phantoms = findPhantomJobMarks(autoMarks, knownJobIds);
    expect(
      phantoms.map(phantom => phantom.line + ' -> ' + phantom.match),
      'every [авто: <job>] mark must name a job id that exists under jobs: in'
        + ' .github/workflows/*.yml - a mark naming a nonexistent job is a check'
        + ' that cannot be run'
    ).to.deep.equal([]);
  });

  it('names the release surfaces the phase shipped (install gates, dialect, screenshots, LEGAL-11, cosign, EN notes)', function() {
    [
      'install-docker',
      'install-npm',
      'mysql-dialect',
      'npm run screenshots',
      'docs/third-party-inventory.md',
      'cosign',
      'v' + PACKAGE_VERSION,
      'GitHub Release',
    ].forEach(required => {
      expect(checklist, 'the checklist must name ' + required).to.include(required);
    });

    // Lawyer verdict Q5 (2026-08-15): the base-image syft scan rides the
    // checklist, run against the digest the release build actually pins,
    // result saved with the release inventory. The item must name the tool
    // AND the digest requirement in its own text.
    const syftLines = checklist.split('\n').filter(line => line.indexOf('syft') !== -1);
    expect(syftLines, 'the checklist must carry the syft base-image scan item (verdict Q5)').to.not.be.empty;
    expect(
      syftLines.some(line => /digest/.test(line)),
      'the syft item must pin the scan to the ACTUAL digest the release build uses'
    ).to.equal(true);

    // D-19: release notes are the owner's EN text.
    expect(checklist, 'release notes language must be stated as English (D-19)').to.match(/notes? .{0,40}английск/i);
  });

  it('keeps the release act community-only and premium scoped after it (D-16/D-20)', function() {
    const boundaryViolations = findCommunityBoundaryViolations(autoMarks);
    expect(
      boundaryViolations.map(mark => mark.line + ' -> ' + mark.match),
      'no portal/premium job may appear as a release-gate mark: the community'
        + ' release act carries only the community image (D-20)'
    ).to.deep.equal([]);

    expect(
      checklist,
      'premium must live in an explicitly after-community section, not inside the release act (D-16)'
    ).to.include('после community-релиза');
  });

  describe('teeth (fabricated checklists through the same detectors)', function() {
    it('a fabricated mark with a fake job id is a phantom', function() {
      const fabricated = '- [авто: isntall-docker] typo job\n- [авто: test] real job\n';
      const phantoms = findPhantomJobMarks(parseAutoMarks(fabricated), knownJobIds);

      expect(phantoms.map(phantom => phantom.match)).to.deep.equal(['[авто: isntall-docker]']);
    });

    it('a fabricated TIMEOFF_ literal is flagged', function() {
      const hits = findDeprecatedEnvLiterals('- [руки] задать TIMEOFF_SESSION_SECRET=…\n- LEAVEPILOT_* только\n');

      expect(hits.map(hit => hit.match)).to.have.lengthOf(1);
      expect(hits[0].match).to.contain('TIMEOFF_');
    });

    it('a fabricated foreign version token is flagged while the package version passes', function() {
      const foreign = findForeignVersionTokens(
        'образ :v2.1.0 откат\nтег v' + PACKAGE_VERSION + ' на master\n', PACKAGE_VERSION);

      expect(foreign.map(hit => hit.match)).to.deep.equal(['2.1.0']);
    });

    it('a fabricated portal mark violates the community boundary', function() {
      const violations = findCommunityBoundaryViolations(parseAutoMarks('- [авто: portal-docker-build] портал\n'));

      expect(violations.map(mark => mark.match)).to.deep.equal(['[авто: portal-docker-build]']);
    });

    it('a clean fabricated checklist passes every detector', function() {
      const fabricated = [
        '- [авто: install-docker] установка по доке зелёная на релизном SHA',
        '- [авто: merge] манифест собран и подписан',
        '- [руки] тег v' + PACKAGE_VERSION + ' на merge-коммите master',
      ].join('\n');
      const marks = parseAutoMarks(fabricated);

      expect(findDeprecatedEnvLiterals(fabricated)).to.deep.equal([]);
      expect(findForeignVersionTokens(fabricated, PACKAGE_VERSION)).to.deep.equal([]);
      expect(findPhantomJobMarks(marks, knownJobIds)).to.deep.equal([]);
      expect(findCommunityBoundaryViolations(marks)).to.deep.equal([]);
    });

    it('the job-id collector rejects nested keys (matrix/steps are not jobs)', function() {
      const fabricatedYml = [
        'name: X',
        'on: push',
        'jobs:',
        '  release:',
        '    runs-on: ubuntu-24.04',
        '    strategy:',
        '      matrix:',
        '        shard: [1, 2]',
        '    steps:',
        '      - name: Go',
        '        run: |',
        '          do_thing:',
      ].join('\n');

      expect(collectJobIds([{file: '.github/workflows/x.yml', source: fabricatedYml}]))
        .to.deep.equal(['release']);
    });
  });
});
