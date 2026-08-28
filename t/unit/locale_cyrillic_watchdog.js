'use strict';

/*
  QUAL-05 / D-14 Cyrillic literal watchdog.

  A user running the English locale must never receive a Russian string.
  Plan 05-03 extracted every user-visible Cyrillic string literal from lib/
  into req.t() locale keys (all five server catalogs + the public catalogs
  req.t() resolves from); what legitimately remains is recorded, with a
  reason per entry, in t/fixtures/cyrillic-allowlist.json. The next commit
  can silently undo that cleanup, so this test turns it into an enforced
  contract instead: it fails the build the moment a Cyrillic string literal
  appears in lib/ or views/ outside the allowlist.

  Why literal-aware scanning: a naive /[а-яА-Я]/ line grep counts legitimate
  Russian COMMENTS too (project convention: bilingual comments are allowed;
  seven lib/ files carry comment-only Cyrillic today). The scanner below
  walks the source character by character, tracking string state (', ", `)
  and comment state (line comments and JS block comments; {{!-- --}} and
  {{! }} for .hbs templates), and flags Cyrillic ONLY inside string literals (JS)
  or template text outside comments (hbs). views/*.hbs carry ZERO Cyrillic
  today (verified); scanning them is cheap future-proofing.

  Modeled on t/unit/env_read_invariant.js (listJsFiles recursion, offender
  objects {file, line, text}, deterministic file-then-line sort) and
  t/unit/locales_no_brand_literal.js (positive/negative teeth, standing
  header). The en-purity walk mirrors the QUAL-05 must_have truth directly:
  locales/en.json contains no Cyrillic values at all.

  Scope: lib/ and views/ only. t/ fixtures (including this allowlist, whose
  reasons quote the literals they sanction) and locales/ catalogs (whose ru
  reference values are Cyrillic BY DESIGN) are deliberately out of scope.

  Known limitation: the lexer does not parse JS regex literals, so a regex
  containing a quote character could open a phantom string state. This is
  accurate on the current codebase (the pre-scan inventory matched the
  plan's independently verified carrier set exactly) and the teeth below
  pin the behaviors the gate exists to enforce.
*/

const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const allowlistFixture = require('../fixtures/cyrillic-allowlist.json');

const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

const cyrillic = /[а-яА-ЯёЁ]/;

/*
  Scanner: line numbers (1-based) where Cyrillic appears INSIDE a string
  literal, comments stripped. Character-walk state machine:

    code -> 'string' on a quote char (' " `), back to 'code' on the same
            quote (escape sequences skipped so \' cannot close the string)
    code -> 'line-comment' on a double slash, back to 'code' at the newline
    code -> 'block-comment' on an opening slash-star, back to 'code' on the
            closing star-slash

  Cyrillic inside a string is recorded with the CURRENT line number, so a
  multi-line template literal attributes its hits to the right lines. A
  Cyrillic character in code or comment state is invisible by construction.
*/
function cyrillicLiteralLines(source) {
  const hits = new Set();
  let state = 'code';
  let quote = null;
  let line = 1;
  let i = 0;

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (c === '\n') {
      line += 1;
      i += 1;
      if (state === 'line-comment') {
        state = 'code';
      }
      continue;
    }

    if (state === 'code') {
      if (c === '/' && next === '/') {
        state = 'line-comment';
        i += 2;
        continue;
      }
      if (c === '/' && next === '*') {
        state = 'block-comment';
        i += 2;
        continue;
      }
      if (c === '\'' || c === '"' || c === '`') {
        state = 'string';
        quote = c;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }

    if (state === 'line-comment') {
      i += 1;
      continue;
    }

    if (state === 'block-comment') {
      if (c === '*' && next === '/') {
        state = 'code';
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    // state === 'string'
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) {
      state = 'code';
      i += 1;
      continue;
    }
    if (cyrillic.test(c)) {
      hits.add(line);
    }
    i += 1;
  }

  return [...hits];
}

/*
  hbs scanner: strip {{!-- ... --}} and {{! ... }} comments, then flag ANY
  remaining Cyrillic line (template text or attribute value — views carry
  zero Cyrillic today, so any appearance is a regression; there is no
  string-literal concept to respect in a template).
*/
function cyrillicTemplateLines(source) {
  const stripped = source
    .replace(/\{!--[\s\S]*?--\}\}/g, '')
    .replace(/\{![\s\S]*?\}\}/g, '');
  const hits = [];
  stripped.split('\n').forEach((line, index) => {
    if (cyrillic.test(line)) {
      hits.push(index + 1);
    }
  });
  return hits;
}

function listFiles(absPath, extensions, into) {
  if (!fs.existsSync(absPath)) {
    return;
  }
  const stats = fs.statSync(absPath);
  if (stats.isDirectory()) {
    fs.readdirSync(absPath).forEach(child => {
      if (child === 'node_modules' || child === '.git') {
        return;
      }
      listFiles(path.join(absPath, child), extensions, into);
    });
    return;
  }
  if (stats.isFile() && extensions.indexOf(path.extname(absPath)) !== -1) {
    into.push(absPath);
  }
}

const scannedDirs = ['lib', 'views'];

function collectFiles(extension) {
  const files = [];
  scannedDirs.forEach(dir => listFiles(path.join(root, dir), [extension], files));
  return files;
}

// Offender objects { file, line, text } for one file, or [] when the file
// has no Cyrillic literal lines (env_read_invariant offendersIn shape).
function offendersIn(absFile) {
  const relativePath = path.relative(root, absFile).split(path.sep).join('/');
  const source = read(relativePath);
  const lines = path.extname(absFile) === '.hbs'
    ? cyrillicTemplateLines(source)
    : cyrillicLiteralLines(source);
  const allLines = source.split('\n');
  return lines.map(line => ({
    file: relativePath,
    line,
    text: allLines[line - 1].trim(),
  }));
}

// Deterministic file-then-line offender list — NOT lexicographic on the
// formatted string — so line 2 sorts before line 10 within a file
// (env_read_invariant allOffenders ordering edge).
function allOffenders() {
  const offenders = [];
  collectFiles('.js').concat(collectFiles('.hbs')).forEach(file => {
    offendersIn(file).forEach(offender => offenders.push(offender));
  });
  offenders.sort((a, b) => {
    if (a.file !== b.file) {
      return a.file < b.file ? -1 : 1;
    }
    return a.line - b.line;
  });
  return offenders;
}

const allowlistKeys = new Set(allowlistFixture.entries.map(entry => entry.file + ':' + entry.line));

function unallowlistedOffenders(offenders) {
  return offenders.filter(offender => !allowlistKeys.has(offender.file + ':' + offender.line));
}

function format(offenders) {
  return offenders.map(o => o.file + ':' + o.line + ': ' + o.text).join('\n');
}

describe('QUAL-05 invariant: no Cyrillic string literals outside the reasoned allowlist', function() {

  const offenders = allOffenders();

  // (1) surfaces-exist: a watchdog whose scanned directories resolve to no
  // files is green for the wrong reason. lib/ holds ~112 .js files and
  // views/ ~87 .hbs files today; the thresholds are deliberately modest so
  // a legitimate edit never trips them, while an emptied tree does.
  it('has surfaces to check', function() {
    expect(
      collectFiles('.js').length,
      'the watchdog lost its input — lib/ resolved to too few .js files, so a green run proves nothing'
    ).to.be.above(20);
    expect(
      fs.existsSync(path.join(root, 'views')),
      'the views/ directory is gone — the hbs half of the scan lost its input'
    ).to.equal(true);
    expect(
      collectFiles('.hbs').length,
      'views/ resolved to too few .hbs files, so the template scan proves nothing'
    ).to.be.above(20);
  });

  // (2) The contract itself — the spec that fails the build on regression.
  it('has no Cyrillic string literal in lib/ or views/ outside the allowlist', function() {
    const unallowlisted = unallowlistedOffenders(offenders);
    expect(
      unallowlisted,
      'these lines carry Cyrillic inside string literals — extract them to req.t() keys ' +
      'in all five server catalogs (and the public catalogs req.t() resolves from), or add a ' +
      'reasoned entry to t/fixtures/cyrillic-allowlist.json:\n' + format(unallowlisted)
    ).to.deep.equal([]);
  });

  // (4, negative teeth half) non-phantom allowlist: every entry must still
  // match a real offender anchor and carry a reason (T-05-07: allowlist
  // growth is review-visible, a stale entry is itself a failure).
  it('has no phantom allowlist entries and a reason on every entry', function() {
    const offenderKeys = new Set(offenders.map(o => o.file + ':' + o.line));
    const phantom = allowlistFixture.entries.filter(entry => !offenderKeys.has(entry.file + ':' + entry.line));
    expect(
      phantom.map(entry => entry.file + ':' + entry.line),
      'allowlist entries that no longer match a Cyrillic literal — the literal was probably ' +
      'translated or moved; delete or update the entry (an allowlist must never grow stale):\n' +
      phantom.map(entry => entry.file + ':' + entry.line + ' (' + entry.reason + ')').join('\n')
    ).to.deep.equal([]);

    const reasonless = allowlistFixture.entries.filter(entry => !entry.reason || !entry.reason.trim());
    expect(
      reasonless.map(entry => entry.file + ':' + entry.line),
      'every allowlist entry must carry a non-empty reason — an unexplained exemption is an escape hatch'
    ).to.deep.equal([]);
  });

  // (3) positive teeth: the detector flags a synthetic Cyrillic literal fed
  // as source input — single, double, and template quotes, and a literal on
  // a line that ALSO carries a Russian comment (the literal must still be
  // caught; only the comment is invisible).
  it('flags synthetic Cyrillic literals in every quote form', function() {
    expect(cyrillicLiteralLines('var a = \'тест\';'),
      'a single-quoted Cyrillic literal must be flagged').to.deep.equal([1]);
    expect(cyrillicLiteralLines('var a = "тест";'),
      'a double-quoted Cyrillic literal must be flagged').to.deep.equal([1]);
    expect(cyrillicLiteralLines('var a = `тест ${x}`;'),
      'a template-literal Cyrillic literal must be flagged').to.deep.equal([1]);
    expect(cyrillicLiteralLines('var a = \'тест\'; // комментарий'),
      'a Cyrillic literal on a line that also carries a Russian comment must be flagged').to.deep.equal([1]);
    expect(cyrillicLiteralLines('var a = \'ok\';\nvar b = "тест";'),
      'the hit must be attributed to the literal\'s own line').to.deep.equal([2]);
  });

  // (4) negative teeth: the detector does NOT flag a synthetic Russian
  // comment — line, block, or trailing — nor escaped quotes that would
  // otherwise close the string early, and it does not flag hbs comments.
  it('does not flag Russian comments or escaped-quote strings', function() {
    expect(cyrillicLiteralLines('// русский комментарий\nvar a = \'ok\';'),
      'a Russian line comment must NOT be flagged (project convention: bilingual comments)').to.deep.equal([]);
    expect(cyrillicLiteralLines('/* русский\n   блок */\nvar a = \'ok\';'),
      'a multi-line Russian block comment must NOT be flagged').to.deep.equal([]);
    expect(cyrillicLiteralLines('var a = \'it\\\'s тест\';'),
      'an escaped quote must not close the string — the literal is still flagged').to.deep.equal([1]);
    expect(cyrillicLiteralLines('var url = \'http://пример\';'),
      'comment-like // inside a string literal is still a string — the literal is flagged').to.deep.equal([1]);

    expect(cyrillicTemplateLines('{{!-- русский комментарий --}}\n<p>ok</p>'),
      'an hbs {{!-- --}} comment must NOT be flagged').to.deep.equal([]);
    expect(cyrillicTemplateLines('{{! русский }}\n<p>ok</p>'),
      'an hbs {{! }} comment must NOT be flagged').to.deep.equal([]);
    expect(cyrillicTemplateLines('<p>тест</p>'),
      'Cyrillic hbs template text must be flagged').to.deep.equal([1]);
  });

  // (5) en-purity — the direct QUAL-05 assertion: locales/en.json carries
  // no Cyrillic value AT ALL (the English catalog is pure by construction;
  // the ru catalog is the Cyrillic reference, uk/be/kk are their own
  // languages, so only en is walked).
  it('keeps locales/en.json free of Cyrillic values', function() {
    const en = JSON.parse(read('locales/en.json'));
    const offenders = [];

    const walk = (value, keyPath) => {
      if (typeof value === 'string') {
        if (cyrillic.test(value)) {
          offenders.push(keyPath + ': ' + value);
        }
      } else if (value && typeof value === 'object') {
        Object.keys(value).forEach(key => walk(value[key], keyPath ? keyPath + '.' + key : key));
      }
    };

    walk(en, '');
    expect(
      offenders,
      'the English server catalog must carry no Cyrillic values — an English-locale user would ' +
      'receive Russian text from these keys:\n' + offenders.join('\n')
    ).to.deep.equal([]);
  });
});
