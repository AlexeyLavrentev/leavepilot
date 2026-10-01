'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {spawnSync, execFileSync} = require('child_process');
const {expect} = require('chai');
const registry = require('../../../lib/verify/stages');
const {LIMITS} = require('../../../lib/verify/artifact_bundle');
const {DEFAULT_GRACE_MS} = require('../../../bin/lib/spawn_group');
const {png} = require('../../fixtures/verify/png');
const {createReproduction, expectsTests} = require('../../../lib/verify/reproduction');
const {featureFlags} = require('../../../lib/verify/stage_diagnostic');

// Loaded lazily so the tracer RED commit keeps this suite's legacy cases green
// while the new helper module does not exist yet.
const certifyHelper = () => require('../../fixtures/verify/certify_profile');

const root = path.resolve(__dirname, '../../..');
const head = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
const validate = args => spawnSync(process.execPath, ['bin/verify.js', ...args], {cwd: root, encoding: 'utf8', timeout: 10000});

describe('verification evidence certification', () => {
  let directory;
  let runRoot;
  let summary;
  let pointer;

  function writeSummary() {
    fs.writeFileSync(path.join(runRoot, 'summary.json'), JSON.stringify(summary));
  }

  function certify(extra = []) {
    return validate(['--validate-run-path-file', pointer, '--expected-head', head, '--started-after', '2026-01-01T00:00:00Z', ...extra]);
  }

  // Names of every real certification record under the shared artifact root
  // (legacy pairs and phase-final named pairs), independent of the
  // test-root override, so a test can prove those files stay untouched.
  function certifiedRootContents() {
    const base = path.join(root, registry.artifactRoot);
    const entries = [];
    const legacy = path.join(base, 'certify');
    if (fs.existsSync(legacy)) {
      entries.push(...fs.readdirSync(legacy).map(file => path.join('certify', file)));
    }
    for (const name of Object.keys(certifyHelper().NAMED_CERTIFICATIONS)) {
      for (const suffix of ['.invocation.json', '.path']) {
        if (fs.existsSync(path.join(base, name + suffix))) { entries.push(`${name}${suffix}`); }
      }
    }
    return entries.sort();
  }

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(root, '.artifacts/verify/evidence-test-'));
    // Confine every certification capture (including actual-CLI children, via
    // the inherited environment) to this test-owned root: the suite must never
    // read, overwrite or delete real invocation records under the shared
    // artifact root — a full-profile certification runs this very suite inside
    // its own workspace while its records must stay untouched.
    process.env.TEST_CERTIFY_ROOT = directory;
    const invocationId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    runRoot = path.join(directory, `${Date.parse(startedAt)}-${invocationId}`);
    fs.mkdirSync(runRoot);
    summary = {schemaVersion: 2, invocationId, startedAt, headSha: head, source: {start: {headSha: head, clean: true}, end: {headSha: head, clean: true}}, profile: 'full', authoritative: true, quarantineCount: 0, aggregate: 'passed', stages: registry.profile('full').stageIds.map(id => {
      const stage = registry.stage(id);
      return {id, status: 'passed', failureClass: null, reason: null, durationMs: 1, attempts: [{number: 1, status: 'passed', evidence: path.join(runRoot, `${id}.attempt-1.json`), reproduction: {command: stage.command, args: stage.args, nodeVersion: process.version, dbContour: 'sqlite', featureFlags: 'not-recorded'}}]};
    })};
    summary.stages.forEach(stage => fs.writeFileSync(stage.attempts[0].evidence, JSON.stringify(stage)));
    writeSummary();
    pointer = path.join(directory, 'current.path');
    fs.writeFileSync(pointer, runRoot + '\n');
  });

  afterEach(() => {
    delete process.env.TEST_CERTIFY_ROOT;
    fs.rmSync(directory, {recursive: true, force: true});
  });

  it('accepts complete first-pass evidence with matching identity and files', () => {
    const result = certify();
    expect(result.status, result.stderr).to.equal(0);
  });

  function upgradeEvidence() {
    summary.schemaVersion = 3;
    for (const stage of summary.stages) {
      const entry = registry.stage(stage.id);
      const diagnostics = {latest: {state: 'unavailable'}, firstFailure: {state: 'unavailable'}};
      const env = {...entry.env, ...(entry.args[0] === 'bin/test.js' ? {LEAVEPILOT_FEATURES: 'all'} : {})};
      if (expectsTests(entry)) {
        diagnostics.latest = {state: 'received', snapshot: {
          version: 1, identity: `${path.basename(runRoot)}/${stage.id}`, event: 'end',
          currentTest: null, lastCompletedTest: {title: 'passed fixture', spec: 't/unit/fixture.js'}, failure: null,
          runtime: {nodeVersion: process.version, browserVersion: null, driverVersion: null, dbContour: 'sqlite', featureFlags: featureFlags(env)},
        }};
        fs.writeFileSync(path.join(runRoot, `${stage.id}.latest.json`), JSON.stringify(diagnostics.latest.snapshot));
      }
      stage.attempts[0].reproduction = createReproduction(entry, {}, diagnostics);
      fs.writeFileSync(stage.attempts[0].evidence, JSON.stringify(stage));
    }
    writeSummary();
  }

  it('accepts schema-3 evidence bound to its original stage sidecars', () => {
    upgradeEvidence();
    const result = certify();
    expect(result.status, result.stderr).to.equal(0);
  });

  for (const [name, mutate] of [
    ['missing sidecar', () => fs.unlinkSync(path.join(runRoot, 'unit-coverage.latest.json'))],
    ['schema downgrade', () => { summary.schemaVersion = 2; }],
    ['wrong replay command', () => { summary.stages[0].attempts[0].reproduction.replay.args = ['bin/verify.js', '--stage', 'package']; }],
    ['unrecorded flags', () => { summary.stages[0].attempts[0].reproduction.featureFlags = 'not-recorded'; }],
    ['unknown metadata', () => { summary.stages[0].attempts[0].reproduction.extra = true; }],
    ['wrong shard', () => { summary.stages[0].attempts[0].reproduction.shard = '4/4'; }],
    ['invented seed', () => { summary.stages[0].attempts[0].reproduction.seed = 42; }],
  ]) {
    it(`rejects schema-3 ${name}`, () => {
      upgradeEvidence(); mutate();
      summary.stages.forEach(stage => fs.writeFileSync(stage.attempts[0].evidence, JSON.stringify(stage)));
      writeSummary();
      expect(certify().status).to.equal(2);
    });
  }

  for (const [name, add] of [
    ['unreferenced credential-bearing log', dir => fs.writeFileSync(path.join(dir, 'browser.log'), 'authorization: Bearer sentinel-security-audit\n')],
    ['unreferenced symlink', dir => fs.symlinkSync(path.join(runRoot, 'summary.json'), path.join(dir, 'extra.json'))],
    ['nested credential-bearing JSON', dir => fs.writeFileSync(path.join(dir, 'extra.json'), JSON.stringify({nested: {password: 'sentinel-security-audit'}}))],
    ['malformed JSON', dir => fs.writeFileSync(path.join(dir, 'extra.json'), '{')],
    ['overwritten JSON credential', dir => fs.writeFileSync(path.join(dir, 'extra.json'), '{"password":"sentinel-security-audit","password":"[REDACTED]"}')],
    ['escaped JSON credential', dir => fs.writeFileSync(path.join(dir, 'extra.json'), '{"pass\\u0077ord":"sentinel-security-audit"}')],
    ['bare GitHub credential', dir => fs.writeFileSync(path.join(dir, 'extra.log'), 'ghp_syntheticSecuritySentinel')],
    ['unlabelled sentinel', dir => fs.writeFileSync(path.join(dir, 'extra.log'), 'stream-output-sentinel')],
    ['unsupported binary', dir => fs.writeFileSync(path.join(dir, 'extra.zip'), Buffer.from([0, 1, 2]))],
    ['invalid UTF-8 log', dir => fs.writeFileSync(path.join(dir, 'extra.log'), Buffer.from([0xc3, 0x28]))],
    ['oversized text', dir => fs.writeFileSync(path.join(dir, 'extra.log'), 'x'.repeat(1024 * 1024 + 1))],
  ]) {
    it(`rejects a full run with ${name}`, () => {
      add(runRoot);
      expect(certify().status).to.equal(2);
    });
    it(`rejects a CI bundle with ${name} outside summary traversal`, () => {
      const {bundle} = ciBundle();
      const extra = path.join(bundle, 'unrelated-diagnostics', 'nested');
      fs.mkdirSync(extra, {recursive: true});
      add(extra);
      expect(validate(['--validate-run-root', bundle, '--expected-head', head]).status).to.equal(2);
    });
  }

  it('retains safe unreferenced diagnostics and redacted values', () => {
    fs.writeFileSync(path.join(runRoot, 'browser.log'), 'request failed\npassword=[REDACTED]\n');
    fs.writeFileSync(path.join(runRoot, 'extra.json'), JSON.stringify({nested: {password: '[REDACTED]'}, error: 'authorization=[REDACTED]', modal: {classTokens: ['modal', 'fade', 'in']}}));
    fs.writeFileSync(path.join(runRoot, 'schema.sql'), "COMMENT 'SHA-256 hash of the Integration API Bearer token'\n");
    fs.writeFileSync(path.join(runRoot, 'results.sarif'), JSON.stringify({description: 'Discovered a potential Bearer token in a source file'}));
    expect(certify().status).to.equal(0);
  });

  it('does not exempt malformed or secret-bearing DOM class lists', () => {
    fs.writeFileSync(path.join(runRoot, 'extra.json'), JSON.stringify({classTokens: 'opaque-value'}));
    expect(certify().status).to.equal(2);
    fs.writeFileSync(path.join(runRoot, 'extra.json'), JSON.stringify({classTokens: ['api_key']}));
    expect(certify().status).to.equal(2);
  });

  it('does not echo malformed JSON contents from validation errors', () => {
    fs.writeFileSync(path.join(runRoot, 'extra.json'), '{"x":sentinel-security-audit}');
    const result = certify();
    expect(result.status).to.equal(2);
    expect(result.stdout + result.stderr).not.to.include('sentinel-security-audit');
  });

  it('rejects hard-linked evidence', () => {
    fs.linkSync(path.join(runRoot, 'summary.json'), path.join(runRoot, 'extra.json'));
    expect(certify().status).to.equal(2);
  });

  it('bounds directory nesting', () => {
    fs.mkdirSync(path.join(runRoot, ...Array(LIMITS.depth + 1).fill('nested')), {recursive: true});
    expect(certify().status).to.equal(2);
  });

  it('bounds JSON nesting', () => {
    let value = 'leaf';
    for (let depth = 0; depth <= LIMITS.jsonDepth; depth++) { value = {nested: value}; }
    fs.writeFileSync(path.join(runRoot, 'extra.json'), JSON.stringify(value));
    expect(certify().status).to.equal(2);
  });

  it('bounds total entries even when every individual file is small', () => {
    for (let index = 0; index <= LIMITS.entries; index++) {
      fs.writeFileSync(path.join(runRoot, `${index}.txt`), '');
    }
    expect(certify().status).to.equal(2);
  });

  it('bounds total bytes even when every file fits its individual limit', () => {
    const content = Buffer.alloc(LIMITS.fileBytes, 32);
    for (let index = 0; index <= LIMITS.totalBytes / LIMITS.fileBytes; index++) {
      fs.writeFileSync(path.join(runRoot, `${index}.txt`), content);
    }
    expect(certify().status).to.equal(2);
  });

  it('checks contents of CI invocations excluded from stage coverage', () => {
    const {bundle} = ciBundle();
    const skipped = path.join(bundle, '123', 'verify-extra', `${Date.now()}-${crypto.randomUUID()}`);
    fs.mkdirSync(skipped, {recursive: true});
    fs.writeFileSync(path.join(skipped, 'summary.json'), JSON.stringify({profile: 'quick'}));
    fs.writeFileSync(path.join(skipped, 'extra.log'), 'password=sentinel-security-audit');
    expect(validate(['--validate-run-root', bundle, '--expected-head', head]).status).to.equal(2);
  });

  for (const [name, options] of [
    ['wrong SHA', ['--expected-head', '0'.repeat(40)]],
    ['stale start', ['--started-after', '2099-01-01T00:00:00Z']],
    ['invalid date', ['--started-after', 'not-a-date']],
  ]) {
    it(`rejects ${name} from the actual CLI options`, () => {
      expect(certify(options).status).to.equal(2);
    });
  }

  for (const [name, mutate] of [
    ['empty stages', () => { summary.stages = []; }],
    ['legacy evidence without provenance', () => { summary.schemaVersion = 1; delete summary.source; }],
    ['dirty initial source despite authority flag', () => { summary.source.start.clean = false; }],
    ['dirty final source despite authority flag', () => { summary.source.end.clean = false; }],
    ['changed revision', () => { summary.source.end.headSha = '0'.repeat(40); }],
    ['missing source snapshot', () => { delete summary.source.end; }],
    ['unexpected source metadata', () => { summary.source.start.password = 'sentinel-secret'; }],
    ['missing browser shard', () => { summary.stages.pop(); }],
    ['duplicate stages', () => { summary.stages[8] = summary.stages[7]; }],
    ['non-authoritative quick evidence', () => { summary.authoritative = false; summary.profile = 'quick'; }],
    ['wrong invocation identity', () => { summary.invocationId = crypto.randomUUID(); }],
    ['missing attempt file', () => { fs.unlinkSync(summary.stages[0].attempts[0].evidence); }],
    ['different attempt contents', () => { fs.writeFileSync(summary.stages[0].attempts[0].evidence, '{}'); }],
    ['diagnostic pass after failure', () => { summary.stages[0].attempts.unshift({number: 1, status: 'failed'}); }],
    ['active quarantine', () => { summary.quarantineCount = 1; }],
    ['escaping attempt path', () => { summary.stages[0].attempts[0].evidence = '/tmp/outside.json'; }],
    ['secret-bearing reproduction arguments', () => { summary.stages[0].attempts[0].reproduction.args = ['secret=sentinel-secret']; }],
    ['unexpected secret-bearing metadata', () => { summary.environment = {password: 'sentinel-secret'}; }],
    ['wrong database contour', () => { summary.stages[0].attempts[0].reproduction.dbContour = 'mysql'; }],
  ]) {
    it(`rejects ${name}`, () => {
      mutate();
      writeSummary();
      expect(certify().status).to.equal(2);
    });
  }

  it('rejects an attempt-file symlink even when its contents match', () => {
    const evidence = summary.stages[0].attempts[0].evidence;
    const other = path.join(directory, 'other.json');
    fs.renameSync(evidence, other);
    fs.symlinkSync(other, evidence);
    expect(certify().status).to.equal(2);
  });

  function ciBundle() {
    const bundle = path.join(directory, 'ci');
    fs.mkdirSync(bundle);
    const runs = [];
    for (const id of [...registry.profile('full').stageIds, 'mysql-dialect']) {
      const startedAt = new Date().toISOString();
      const invocationId = crypto.randomUUID();
      const name = `${Date.parse(startedAt)}-${invocationId}`;
      const dir = path.join(bundle, '123', `verify-${id}`, name);
      fs.mkdirSync(dir, {recursive: true});
      const entry = registry.stage(id);
      const stage = {id, status: 'passed', failureClass: null, reason: null, durationMs: 1, attempts: [{number: 1, status: 'passed', evidence: `/home/runner/work/repo/.artifacts/verify/${name}/${id}.attempt-1.json`, reproduction: {command: entry.command, args: entry.args, nodeVersion: process.version, dbContour: id === 'mysql-dialect' ? 'mysql' : 'sqlite', featureFlags: 'not-recorded'}}]};
      const record = {...summary, profile: null, invocationId, startedAt, stages: [stage]};
      fs.writeFileSync(path.join(dir, `${id}.attempt-1.json`), JSON.stringify(stage));
      fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(record));
      runs.push({dir, record});
    }
    return {bundle, runs};
  }

  it('validates combined downloaded CI roots without rewriting original paths', () => {
    const {bundle} = ciBundle();
    const result = validate(['--validate-run-root', bundle, '--expected-head', head]);
    expect(result.status, result.stderr).to.equal(0);
  });

  it('validates complete CI evidence including unreferenced PNG diagnostics', () => {
    const {bundle} = ciBundle();
    const diagnostics = path.join(bundle, '123', 'browser-batch-diagnostics-shard-2');
    fs.mkdirSync(diagnostics);
    fs.writeFileSync(path.join(diagnostics, 'screenshot.png'), png());
    const result = validate(['--validate-run-root', bundle, '--expected-head', head]);
    expect(result.status, result.stderr).to.equal(0);
    fs.appendFileSync(path.join(diagnostics, 'screenshot.png'), 'password=sentinel-security-audit');
    const rejected = validate(['--validate-run-root', bundle, '--expected-head', head]);
    expect(rejected.status).to.equal(2);
    expect(rejected.stderr).not.to.include('sentinel-security-audit');
  });

  for (const [name, alter] of [
    ['missing lint contour', runs => fs.rmSync(runs[0].dir, {recursive: true})],
    ['failed contour', runs => { runs[0].record.aggregate = 'failed'; fs.writeFileSync(path.join(runs[0].dir, 'summary.json'), JSON.stringify(runs[0].record)); }],
    ['mixed revisions', runs => { runs[0].record.headSha = '0'.repeat(40); fs.writeFileSync(path.join(runs[0].dir, 'summary.json'), JSON.stringify(runs[0].record)); }],
    ['missing summary', runs => fs.unlinkSync(path.join(runs[0].dir, 'summary.json'))],
  ]) {
    it(`rejects CI bundles with ${name}`, () => {
      const {bundle, runs} = ciBundle();
      alter(runs);
      expect(validate(['--validate-run-root', bundle, '--expected-head', head]).status).to.equal(2);
    });
  }

  function writeProfileRun(profileId, parent, startedAt = new Date().toISOString()) {
    const invocationId = crypto.randomUUID();
    const run = path.join(parent, `${Date.parse(startedAt)}-${invocationId}`);
    fs.mkdirSync(run, {recursive: true});
    const record = {...summary, invocationId, startedAt, profile: profileId, stages: registry.profile(profileId).stageIds.map(id => {
      const stage = registry.stage(id);
      const contour = stage.env && stage.env.TEST_DB_DIALECT === 'mysql' ? 'mysql' : 'sqlite';
      return {id, status: 'passed', failureClass: null, reason: null, durationMs: 1, attempts: [{number: 1, status: 'passed', evidence: path.join(run, `${id}.attempt-1.json`), reproduction: {command: stage.command, args: stage.args, nodeVersion: process.version, dbContour: contour, featureFlags: 'not-recorded'}}]};
    })};
    record.stages.forEach(stage => fs.writeFileSync(stage.attempts[0].evidence, JSON.stringify(stage)));
    fs.writeFileSync(path.join(run, 'summary.json'), JSON.stringify(record));
    return {run, record};
  }

  describe('expected-profile certification', () => {
    const profilePointer = profileId => {
      const {run} = writeProfileRun(profileId, directory);
      const file = path.join(directory, `${profileId}.path`);
      fs.writeFileSync(file, run + '\n');
      return file;
    };

    it('validates a fresh full pointer with its explicit expected profile', () => {
      const file = path.join(directory, 'full.path');
      fs.writeFileSync(file, runRoot + '\n');
      expect(validate(['--validate-run-path-file', file, '--expected-profile', 'full', '--expected-head', head, '--started-after', '2026-01-01T00:00:00Z']).status).to.equal(0);
    });

    for (const profileId of ['ci-mysql', 'ci-runtime']) {
      it(`validates a fresh ${profileId} pointer only through its expected profile`, () => {
        expect(validate(['--validate-run-path-file', profilePointer(profileId), '--expected-profile', profileId, '--expected-head', head, '--started-after', '2026-01-01T00:00:00Z']).status).to.equal(0);
        // Without the explicit profile the pointer path keeps its full-only contract.
        expect(validate(['--validate-run-path-file', profilePointer(profileId), '--expected-head', head]).status).to.equal(2);
      });
    }

    it('rejects evidence of a different profile than the expected one', () => {
      expect(validate(['--validate-run-path-file', profilePointer('ci-mysql'), '--expected-profile', 'ci-runtime', '--expected-head', head, '--started-after', '2026-01-01T00:00:00Z']).status).to.equal(2);
    });

    it('rejects an expected profile with an incomplete stage set', () => {
      const {run, record} = writeProfileRun('ci-runtime', directory);
      record.stages.pop();
      fs.writeFileSync(path.join(run, 'summary.json'), JSON.stringify(record));
      const file = path.join(directory, 'incomplete.path');
      fs.writeFileSync(file, run + '\n');
      expect(validate(['--validate-run-path-file', file, '--expected-profile', 'ci-runtime', '--expected-head', head, '--started-after', '2026-01-01T00:00:00Z']).status).to.equal(2);
    });

    it('rejects a non-authoritative or unknown expected profile', () => {
      const file = path.join(directory, 'full.path');
      fs.writeFileSync(file, runRoot + '\n');
      expect(validate(['--validate-run-path-file', file, '--expected-profile', 'quick', '--expected-head', head]).status).to.equal(2);
      expect(validate(['--validate-run-path-file', file, '--expected-profile', 'nope', '--expected-head', head]).status).to.equal(2);
    });

    it('keeps runtime stages bound to their registered reproduction contour', () => {
      const {run, record} = writeProfileRun('ci-runtime', directory);
      record.stages[0].attempts[0].reproduction.dbContour = 'mysql';
      fs.writeFileSync(record.stages[0].attempts[0].evidence, JSON.stringify(record.stages[0]));
      fs.writeFileSync(path.join(run, 'summary.json'), JSON.stringify(record));
      const file = path.join(directory, 'contour.path');
      fs.writeFileSync(file, run + '\n');
      expect(validate(['--validate-run-path-file', file, '--expected-profile', 'ci-runtime', '--expected-head', head, '--started-after', '2026-01-01T00:00:00Z']).status).to.equal(2);
    });

    it('rejects an expected profile for an aggregate CI directory', () => {
      const {bundle} = ciBundle();
      expect(validate(['--validate-run-root', bundle, '--expected-profile', 'full', '--expected-head', head]).status).to.equal(2);
    });

    it('rejects an expected profile without a validation target', () => {
      expect(validate(['--expected-profile', 'full', '--expected-head', head]).status).to.equal(2);
    });

    it('accepts runtime invocations in a complete CI bundle without requiring them', () => {
      const {bundle} = ciBundle();
      writeProfileRun('ci-runtime', path.join(bundle, '123', 'verify-ci-runtime'));
      expect(validate(['--validate-run-root', bundle, '--expected-head', head]).status).to.equal(0);
    });

    it('rejects duplicated runtime stage evidence in a CI bundle', () => {
      const {bundle} = ciBundle();
      writeProfileRun('ci-runtime', path.join(bundle, '123', 'verify-ci-runtime-a'));
      writeProfileRun('ci-runtime', path.join(bundle, '123', 'verify-ci-runtime-b'));
      expect(validate(['--validate-run-root', bundle, '--expected-head', head]).status).to.equal(2);
    });
  });

  describe('certification helper', () => {
    it('captures the invocation identity and clears its own pointer before spawning', async () => {
      const observed = [];
      const outcome = await certifyHelper().runCertification('ci-runtime', async (execution, budgetMs) => {
        observed.push({
          metadata: fs.readFileSync(certifyHelper().metadataFile('real-runtime'), 'utf8'),
          pointer: fs.readFileSync(certifyHelper().pointerFile('real-runtime'), 'utf8'),
          execution, budgetMs,
        });
        return {code: 0};
      });
      expect(outcome.code).to.equal(0);
      const metadata = JSON.parse(observed[0].metadata);
      expect(Object.keys(metadata).sort()).to.deep.equal(['expectedHead', 'expectedProfile', 'name', 'pointer', 'schemaVersion', 'startedAfter']);
      expect(metadata.schemaVersion).to.equal(1);
      expect(metadata.name).to.equal('real-runtime');
      expect(metadata.expectedProfile).to.equal('ci-runtime');
      expect(metadata.expectedHead).to.equal(head);
      expect(metadata.pointer).to.equal(certifyHelper().pointerFile('real-runtime'));
      expect(Number.isFinite(Date.parse(metadata.startedAfter))).to.equal(true);
      expect(observed[0].pointer).to.equal('');
    });

    it('spawns the canonical full command and direct commands for the other profiles', async () => {
      const commands = {};
      for (const profileId of ['full', 'ci-mysql', 'ci-runtime']) {
        await certifyHelper().runCertification(profileId, async (execution, budgetMs) => {
          commands[profileId] = {execution, budgetMs};
          return {code: profileId === 'full' ? 1 : 0};
        });
      }
      expect(commands.full.execution.args.slice(0, 3)).to.deep.equal(['run', 'verify', '--']);
      expect(commands.full.execution.args).to.include('--run-path-file');
      for (const profileId of ['ci-mysql', 'ci-runtime']) {
        const pair = certifyHelper().CERTIFICATIONS[profileId];
        expect(commands[profileId].execution.command).to.equal(process.execPath);
        expect(commands[profileId].execution.args).to.deep.equal(['bin/verify.js', '--profile', profileId, '--run-path-file', certifyHelper().pointerFile(pair.name)]);
      }
      const total = registry.profile('ci-runtime').stageIds.reduce((sum, id) => sum + registry.stage(id).deadlineMs, 0) + 2 * DEFAULT_GRACE_MS;
      expect(commands['ci-runtime'].budgetMs).to.equal(total);
      expect(commands.full.budgetMs).to.be.a('number').and.to.be.greaterThan(0);
    });

    it('propagates a failed child once without certifying or retrying', async () => {
      let calls = 0;
      const outcome = await certifyHelper().runCertification('ci-mysql', async () => {
        calls += 1;
        return {code: 1};
      });
      expect(calls).to.equal(1);
      expect(outcome.code).to.equal(1);
      expect(fs.existsSync(certifyHelper().metadataFile('real-mysql'))).to.equal(true);
    });

    it('validates from the saved invocation timestamp without regenerating it', async () => {
      let saved;
      await certifyHelper().runCertification('ci-runtime', async () => {
        const {run} = writeProfileRun('ci-runtime', directory);
        fs.writeFileSync(certifyHelper().pointerFile('real-runtime'), run + '\n');
        saved = JSON.parse(fs.readFileSync(certifyHelper().metadataFile('real-runtime'), 'utf8'));
        return {code: 0};
      });
      await new Promise(resolve => setTimeout(resolve, 5));
      const observed = [];
      const outcome = await certifyHelper().validateCertification('ci-runtime', async (execution, timeoutMs) => {
        observed.push({execution, timeoutMs});
        return {code: 0};
      });
      expect(outcome.code).to.equal(0);
      const args = observed[0].execution.args;
      const startedAfter = args[args.indexOf('--started-after') + 1];
      expect(startedAfter).to.equal(saved.startedAfter);
      expect(Date.parse(saved.startedAfter)).to.be.lessThan(Date.now());
      expect(args[args.indexOf('--expected-profile') + 1]).to.equal('ci-runtime');
      expect(args[args.indexOf('--expected-head') + 1]).to.equal(head);
      expect(args).to.include('--validate-run-path-file');
      expect(observed[0].timeoutMs).to.be.a('number').and.to.be.greaterThan(0);
    });

    for (const [name, mutate] of [
      ['a missing field', metadata => delete metadata.expectedHead],
      ['an extra field', metadata => { metadata.extra = true; }],
      ['a wrong schema version', metadata => { metadata.schemaVersion = 2; }],
      ['a mismatched name pair', metadata => { metadata.name = 'real-mysql'; }],
      ['a foreign pointer path', metadata => { metadata.pointer = path.join(directory, 'other.path'); }],
      ['a malformed head', metadata => { metadata.expectedHead = '0'.repeat(12); }],
      ['a malformed timestamp', metadata => { metadata.startedAfter = 'not-a-date'; }],
    ]) {
      it(`rejects saved metadata with ${name}`, async () => {
        await certifyHelper().runCertification('full', async () => ({code: 0}));
        const file = certifyHelper().metadataFile('local-full');
        const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
        mutate(metadata);
        fs.writeFileSync(file, JSON.stringify(metadata));
        let rejected = null;
        try { await certifyHelper().validateCertification('full', async () => ({code: 0})); } catch (error) { rejected = error; }
        expect(rejected, 'expected validation to reject the metadata').to.be.instanceOf(Error);
      });
    }

    it('rejects validation after HEAD moved', async () => {
      const file = certifyHelper().metadataFile('local-full');
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, JSON.stringify({schemaVersion: 1, name: 'local-full', expectedProfile: 'full', expectedHead: '0'.repeat(40), startedAfter: new Date().toISOString(), pointer: certifyHelper().pointerFile('local-full')}));
      let rejected = null;
      try { await certifyHelper().validateCertification('full', async () => ({code: 0})); } catch (error) { rejected = error; }
      expect(rejected).to.be.instanceOf(Error);
    });

    it('rejects an older successful pointer on the same HEAD through the actual CLI', () => {
      const file = certifyHelper().metadataFile('local-full');
      fs.mkdirSync(path.dirname(file), {recursive: true});
      // One millisecond after the retained run's own start: deterministic
      // staleness even when beforeEach and this test land in the same clock
      // millisecond (the validator accepts an equal-or-later run start).
      const staleAfter = new Date(Date.parse(summary.startedAt) + 1).toISOString();
      fs.writeFileSync(file, JSON.stringify({schemaVersion: 1, name: 'local-full', expectedProfile: 'full', expectedHead: head, startedAfter: staleAfter, pointer: certifyHelper().pointerFile('local-full')}));
      // The retained green run predates the new invocation's start time.
      fs.writeFileSync(certifyHelper().pointerFile('local-full'), runRoot + '\n');
      const result = spawnSync(process.execPath, ['t/fixtures/verify/certify_profile.js', '--validate', 'full'], {cwd: root, encoding: 'utf8', timeout: 45000});
      expect(result.status, result.stdout + result.stderr).to.equal(2);
    });

    it('accepts a fresh full pointer through the actual helper CLI', () => {
      const file = certifyHelper().metadataFile('local-full');
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, JSON.stringify({schemaVersion: 1, name: 'local-full', expectedProfile: 'full', expectedHead: head, startedAfter: '2026-01-01T00:00:00Z', pointer: certifyHelper().pointerFile('local-full')}));
      fs.writeFileSync(certifyHelper().pointerFile('local-full'), runRoot + '\n');
      const result = spawnSync(process.execPath, ['t/fixtures/verify/certify_profile.js', '--validate', 'full'], {cwd: root, encoding: 'utf8', timeout: 45000});
      expect(result.status, result.stdout + result.stderr).to.equal(0);
    });

    for (const argv of [[], ['--run'], ['--run', 'nope'], ['--validate', 'quick']]) {
      it(`rejects helper arguments ${JSON.stringify(argv)}`, () => {
        const result = spawnSync(process.execPath, ['t/fixtures/verify/certify_profile.js', ...argv], {cwd: root, encoding: 'utf8', timeout: 15000});
        expect(result.status).to.equal(2);
      });
    }

    it('never reads, overwrites or deletes real certification records', async () => {
      // Regression: this suite's captures used to clean the shared artifact
      // root, which destroyed the live invocation records of a full-profile
      // certification executing its unit stage in the same workspace.
      const sentinelRoot = fs.mkdtempSync(path.join(root, '.artifacts/verify/evidence-sentinel-'));
      const created = [];
      try {
        delete process.env.TEST_CERTIFY_ROOT;
        const realFiles = [
          certifyHelper().metadataFile('local-full'),
          certifyHelper().pointerFile('local-full'),
          ...Object.keys(certifyHelper().NAMED_CERTIFICATIONS)
            .flatMap(name => [certifyHelper().namedMetadataFile(name), certifyHelper().namedPointerFile(name)]),
        ];
        const original = certifiedRootContents();
        for (const file of realFiles) {
          if (fs.existsSync(file)) { continue; }
          fs.mkdirSync(path.dirname(file), {recursive: true});
          fs.writeFileSync(file, 'live-certification-record\n');
          created.push(file);
        }
        process.env.TEST_CERTIFY_ROOT = sentinelRoot;
        await certifyHelper().runCertification('full', async () => ({code: 0}));
        await certifyHelper().runNamedCertification('phase02-final-runtime', 'ci-runtime', async () => ({code: 0}));
        expect(fs.existsSync(path.join(sentinelRoot, 'certify', 'local-full.json'))).to.equal(true);
        expect(fs.existsSync(path.join(sentinelRoot, 'phase02-final-runtime.invocation.json'))).to.equal(true);
        for (const file of created) {
          expect(fs.readFileSync(file, 'utf8')).to.equal('live-certification-record\n');
        }
        // Exactly the pre-existing records plus this test's own sentinels:
        // the captures neither added nor removed anything in the real root.
        const base = path.join(root, registry.artifactRoot);
        expect(certifiedRootContents()).to.deep.equal(
          original.concat(created.map(file => path.relative(base, file))).sort()
        );
      } finally {
        delete process.env.TEST_CERTIFY_ROOT;
        for (const file of created) { fs.rmSync(file, {force: true}); }
        try { fs.rmdirSync(path.join(root, registry.artifactRoot, 'certify')); }
        catch { /* absent or holding live records: leave it alone */ }
        fs.rmSync(sentinelRoot, {recursive: true, force: true});
      }
    });
  });

  describe('named final certifications', () => {
    it('captures a phase-final invocation identity beside its own pointer', async () => {
      const observed = [];
      const outcome = await certifyHelper().runNamedCertification('phase02-final-runtime', 'ci-runtime', async (execution, budgetMs) => {
        observed.push({
          metadata: fs.readFileSync(certifyHelper().namedMetadataFile('phase02-final-runtime'), 'utf8'),
          pointer: fs.readFileSync(certifyHelper().namedPointerFile('phase02-final-runtime'), 'utf8'),
          execution, budgetMs,
        });
        return {code: 0};
      });
      expect(outcome.code).to.equal(0);
      const metadata = JSON.parse(observed[0].metadata);
      expect(metadata.name).to.equal('phase02-final-runtime');
      expect(metadata.expectedProfile).to.equal('ci-runtime');
      expect(metadata.pointer).to.equal(certifyHelper().namedPointerFile('phase02-final-runtime'));
      // The invocation record and its pointer live directly beside the run
      // evidence, never inside the reusable legacy certify directory — here
      // inside this suite's confined root, in production inside the artifact
      // root itself.
      expect(path.dirname(metadata.pointer)).to.equal(directory);
      expect(observed[0].pointer).to.equal('');
      expect(observed[0].execution.args).to.include('--run-path-file');
      const total = registry.profile('ci-runtime').stageIds.reduce((sum, id) => sum + registry.stage(id).deadlineMs, 0) + 2 * DEFAULT_GRACE_MS;
      expect(observed[0].budgetMs).to.equal(total);
    });

    it('validates a named invocation from its saved identity without regenerating it', async () => {
      let saved;
      await certifyHelper().runNamedCertification('phase02-final-runtime', 'ci-runtime', async () => {
        const {run} = writeProfileRun('ci-runtime', directory);
        fs.writeFileSync(certifyHelper().namedPointerFile('phase02-final-runtime'), run + '\n');
        saved = JSON.parse(fs.readFileSync(certifyHelper().namedMetadataFile('phase02-final-runtime'), 'utf8'));
        return {code: 0};
      });
      const observed = [];
      const outcome = await certifyHelper().validateNamedCertification('phase02-final-runtime', 'ci-runtime', async execution => {
        observed.push({execution});
        return {code: 0};
      });
      expect(outcome.code).to.equal(0);
      const args = observed[0].execution.args;
      expect(args[args.indexOf('--started-after') + 1]).to.equal(saved.startedAfter);
      expect(args[args.indexOf('--expected-profile') + 1]).to.equal('ci-runtime');
      expect(args[args.indexOf('--expected-head') + 1]).to.equal(head);
      expect(args[args.indexOf('--validate-run-path-file') + 1]).to.equal(saved.pointer);
    });

    it('rejects a named invocation bound to a different profile', async () => {
      let rejected = null;
      try { await certifyHelper().runNamedCertification('phase02-final-local', 'ci-mysql', async () => ({code: 0})); }
      catch (error) { rejected = error; }
      expect(rejected, 'expected the pair mismatch to reject').to.be.instanceOf(Error);
      expect(fs.existsSync(certifyHelper().namedMetadataFile('phase02-final-local'))).to.equal(false);
    });

    it('accepts a fresh named pointer through the actual helper CLI', () => {
      const name = 'phase02-final-local';
      fs.writeFileSync(certifyHelper().namedMetadataFile(name), JSON.stringify({
        schemaVersion: 1, name, expectedProfile: 'full', expectedHead: head,
        startedAfter: '2026-01-01T00:00:00Z', pointer: certifyHelper().namedPointerFile(name),
      }));
      fs.writeFileSync(certifyHelper().namedPointerFile(name), runRoot + '\n');
      const result = spawnSync(process.execPath,
        ['t/fixtures/verify/certify_profile.js', '--validate', '--name', name, '--profile', 'full'],
        {cwd: root, encoding: 'utf8', timeout: 45000});
      expect(result.status, result.stdout + result.stderr).to.equal(0);
    });

    it('rejects an older named pointer on the same HEAD through the actual CLI', () => {
      const name = 'phase02-final-mysql';
      fs.writeFileSync(certifyHelper().namedMetadataFile(name), JSON.stringify({
        schemaVersion: 1, name, expectedProfile: 'ci-mysql', expectedHead: head,
        startedAfter: new Date().toISOString(), pointer: certifyHelper().namedPointerFile(name),
      }));
      // The retained green run predates the new invocation's start time.
      fs.writeFileSync(certifyHelper().namedPointerFile(name), runRoot + '\n');
      const result = spawnSync(process.execPath,
        ['t/fixtures/verify/certify_profile.js', '--validate', '--name', name, '--profile', 'ci-mysql'],
        {cwd: root, encoding: 'utf8', timeout: 45000});
      expect(result.status, result.stdout + result.stderr).to.equal(2);
    });

    for (const argv of [
      ['--run', '--name', 'phase02-final-local', '--profile', 'ci-mysql'],
      ['--run', '--name', 'unknown-final-name', '--profile', 'full'],
      ['--validate', '--name', 'phase02-final-local'],
      ['--run', '--name', 'phase02-final-local', '--profile', 'full', 'extra'],
    ]) {
      it(`rejects helper arguments ${JSON.stringify(argv)}`, () => {
        const result = spawnSync(process.execPath, ['t/fixtures/verify/certify_profile.js', ...argv], {cwd: root, encoding: 'utf8', timeout: 15000});
        expect(result.status).to.equal(2);
      });
    }
  });
});
