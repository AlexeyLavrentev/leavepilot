'use strict';

const path = require('path');
const timings = require('../../t/fixtures/verify/stage_timings.json');
const mysqlDialectSpecs = require('../../t/fixtures/dialect-sensitive-specs.json').specs
  .map(entry => entry.file);

const node = process.execPath;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const timed = (name, command, args, extra = {}) => Object.freeze(Object.assign({
  id: name,
  command,
  args: Object.freeze(args),
  dependencies: Object.freeze([]),
  resource: 'default',
  deadlineMs: timings.local[name === 'unit-coverage' ? 'unitCoverage' : name === 'sqlite-migration' ? 'sqliteMigration' : name === 'css-build-diff' ? 'cssBuildDiff' : name].deadlineMs,
}, extra));

const chromePrerequisite = Object.freeze({
  command: node,
  args: Object.freeze(['bin/browser_setup.js', '--check']),
  setup: 'node bin/browser_setup.js --bootstrap',
});

const stages = Object.freeze([
  // Planning scratch scripts are intentionally not production source and are
  // outside the canonical stage's contract; `npm run lint` keeps its public
  // broad behavior unchanged.
  timed('lint', npm, ['run', 'lint', '--', '--ignore-pattern', '.planning/**']),
  timed('unit-coverage', npm, ['run', 'test:coverage'], {env: {
    NODE_ENV: 'test',
    DB_DIALECT: 'sqlite',
    DB_STORAGE: '/tmp/verify-unit.sqlite',
    LEAVEPILOT_FEATURES: 'all',
    TEST_ENFORCE_SKIP_HONESTY: 'true',
  }}),
  timed('sqlite-migration', node, ['bin/db_update.js'], {env: {
    NODE_ENV: 'test',
    DB_DIALECT: 'sqlite',
    DB_STORAGE: '/tmp/verify-sqlite-migration.sqlite',
  }}),
  timed('css-build-diff', node, ['bin/verify_css.js']),
  timed('package', npm, ['pack', '--dry-run', '--json']),
  ...[1, 2, 3, 4].map(index => Object.freeze({
    id: `browser-${index}`,
    command: node,
    args: Object.freeze(['bin/test.js', '--integration-only', '--keep-going', `--shard=${index}/4`]),
    dependencies: Object.freeze([]),
    resource: 'browser',
    deadlineMs: 1800000,
    prerequisite: chromePrerequisite,
    env: {
      TEST_INTEGRATION_BATCH_SIZE: '1',
      TEST_EXECUTION_TIMEOUT_MS: '120000',
      TEST_RETRIES: '0',
      TEST_TRACE_FORMS: '1',
      TEST_ENFORCE_SKIP_HONESTY: 'true',
    },
  })),
  Object.freeze({
    id: 'mysql-dialect',
    command: node,
    args: Object.freeze(['bin/test.js'].concat(mysqlDialectSpecs)),
    dependencies: Object.freeze([]),
    resource: 'mysql',
    deadlineMs: 300000,
    prerequisite: Object.freeze({command: node, args: Object.freeze(['-e', "if (!process.env.DB_HOST) process.exit(1)"]), setup: 'Start MySQL 8.0.45 and set DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD'}),
    env: {
      NODE_ENV: 'test',
      TEST_DB_DIALECT: 'mysql',
      TEST_RETRIES: '0',
      TEST_ENFORCE_SKIP_HONESTY: 'true',
    },
  }),
  Object.freeze({id: 'test-pass', command: node, args: Object.freeze(['-e', 'process.exit(0)']), dependencies: Object.freeze([]), resource: 'test', deadlineMs: 1000}),
  Object.freeze({id: 'test-fail', command: node, args: Object.freeze(['-e', 'process.exit(1)']), dependencies: Object.freeze([]), resource: 'test', deadlineMs: 1000}),
  Object.freeze({id: 'test-blocked', command: node, args: Object.freeze(['-e', 'process.exit(0)']), dependencies: Object.freeze(['test-fail']), resource: 'test', deadlineMs: 1000}),
  Object.freeze({id: 'test-timeout-tree', command: node, args: Object.freeze(['-e', "const {spawn} = require('child_process'); const grandchild = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000000)\"], {stdio: 'ignore'}); process.stdout.write('tree-grandchild=' + grandchild.pid + '\\n'); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000000);"]), dependencies: Object.freeze([]), resource: 'test', deadlineMs: 50}),
]);

const profiles = Object.freeze([
  Object.freeze({id: 'full', authoritative: true, stageIds: Object.freeze(['lint', 'unit-coverage', 'sqlite-migration', 'css-build-diff', 'package', 'browser-1', 'browser-2', 'browser-3', 'browser-4'])}),
  Object.freeze({id: 'quick', authoritative: false, stageIds: Object.freeze(['lint']), note: 'Feedback only; not an authoritative verification result.'}),
  Object.freeze({id: 'ci-browser', authoritative: true, stageIds: Object.freeze(['browser-1', 'browser-2', 'browser-3', 'browser-4'])}),
  Object.freeze({id: 'ci-mysql', authoritative: true, stageIds: Object.freeze(['mysql-dialect'])}),
  Object.freeze({id: 'test-graph', authoritative: true, stageIds: Object.freeze(['test-fail', 'test-blocked', 'test-pass'])}),
]);

const stageById = new Map(stages.map(entry => [entry.id, entry]));
const profileById = new Map(profiles.map(entry => [entry.id, entry]));
const stage = id => {
  const value = stageById.get(id);
  if (!value) { throw new Error(`Unknown stage: ${id}`); }
  return value;
};
const profile = id => {
  const value = profileById.get(id);
  if (!value) { throw new Error(`Unknown profile: ${id}`); }
  return value;
};

module.exports = Object.freeze({
  artifactRoot: path.join('.artifacts', 'verify'),
  stages,
  profiles,
  stage,
  profile,
});
