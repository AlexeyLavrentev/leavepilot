'use strict';

/*
  CI install-command watchdog (QUAL-06, D-15) - a standing gate, not a
  one-time cleanup.

  `npm ci` is the only install path in CI. That is the whole integrity gate
  for npm packages: npm verifies every package's bytes against the committed
  lockfile hashes and fails with EINTEGRITY on any mismatch (verified
  empirically, 05-RESEARCH.md "npm ci integrity enforcement"). `npm install`
  and `npm update` instead resolve the registry at run time and silently
  rewrite the lockfile - on a compromised registry or a mutated package that
  is exactly the behavior a build must not have.

  This spec scans every workflow under .github/workflows and fails the build
  on any npm install / npm update invocation. `npm ci`, `npm run` and
  comment lines are not offenders. Teeth run on synthetic snippets so the
  detector is proven non-vacuous without breaking real workflows.
*/

const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');

// npm install / npm update in any argument shape (bare, with packages, with
// flags). Word boundaries keep `npm ci` and `npm run` out by construction.
const INSTALL_COMMAND = /\bnpm\s+(?:install|update)\b/;

function collectWorkflowFiles(dir) {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const target = path.join(dir, entry.name);
    return entry.isDirectory() ? collectWorkflowFiles(target) : [target];
  }).filter(file => file.endsWith('.yml') || file.endsWith('.yaml')).sort();
}

function findInstallCommands(fileSources) {
  const offenders = [];

  fileSources.forEach(({file, source}) => {
    source.split('\n').forEach((line, lineNumber) => {
      const isComment = line.trim().indexOf('#') === 0;

      if (!isComment && INSTALL_COMMAND.test(line)) {
        offenders.push({file: file, line: lineNumber + 1, match: line.trim()});
      }
    });
  });

  return offenders.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);
}

function collectWorkflowSources() {
  return collectWorkflowFiles(WORKFLOWS_DIR).map(file => ({
    file: path.relative(REPO_ROOT, file),
    source: fs.readFileSync(file, 'utf8'),
  }));
}

describe('CI install commands (D-15)', function() {
  it('has a real surface to guard (workflow files exist)', function() {
    const sources = collectWorkflowSources();

    expect(sources.length).to.be.at.least(1);
    expect(
      sources.map(source => source.file),
      'the CI workflows live in .github/workflows and must stay scannable'
    ).to.include('.github/workflows/core-ci.yml');
  });

  it('every workflow installs with npm ci - zero npm install/npm update invocations', function() {
    const offenders = findInstallCommands(collectWorkflowSources());

    expect(
      offenders.map(offender => offender.file + ':' + offender.line + ' -> ' + offender.match),
      'npm ci is the only install path in CI (D-15): npm install/npm update resolve the'
        + ' registry at run time and bypass the lockfile-integrity gate'
    ).to.deep.equal([]);
  });

  it('teeth: flags npm install and npm update in synthetic workflow lines', function() {
    const offenders = findInstallCommands([
      {file: '.github/workflows/b.yml', source: '      - name: Install\n        run: npm install\n'},
      {file: '.github/workflows/a.yml', source: '        run: npm update left-pad\n'},
      {file: '.github/workflows/b.yml', source: '        run: npm install --no-audit\n'},
    ]);

    expect(offenders).to.deep.equal([
      {file: '.github/workflows/a.yml', line: 1, match: 'run: npm update left-pad'},
      {file: '.github/workflows/b.yml', line: 1, match: 'run: npm install --no-audit'},
      {file: '.github/workflows/b.yml', line: 2, match: 'run: npm install'},
    ]);
  });

  it('teeth: npm ci, npm run and comments are not offenders', function() {
    const offenders = findInstallCommands([{
      file: '.github/workflows/core-ci.yml',
      source: [
        '# npm install is forbidden by D-15: it resolves the registry at run time.',
        '      - name: Install dependencies',
        '        run: npm ci',
        '        run: npm ci --omit=dev',
        '        run: npm run build-css',
        '        run: npm audit --omit=dev --audit-level=high',
        '        run: npm publish --dry-run',
      ].join('\n'),
    }]);

    expect(offenders).to.deep.equal([]);
  });

  it('teeth: an install hidden inside a multi-line run block is still flagged', function() {
    const offenders = findInstallCommands([{
      file: '.github/workflows/core-ci.yml',
      source: [
        '        run: |',
        '          set -euo pipefail',
        '          npm ci',
        '          npm install --no-save ./local-pkg',
      ].join('\n'),
    }]);

    expect(offenders).to.deep.equal([
      {file: '.github/workflows/core-ci.yml', line: 4, match: 'npm install --no-save ./local-pkg'},
    ]);
  });
});
