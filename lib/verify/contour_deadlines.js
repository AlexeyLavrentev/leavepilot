'use strict';

const {isDeepStrictEqual} = require('util');
const stageIds = ['browser-1', 'browser-2', 'browser-3', 'browser-4', 'mysql-dialect'];
const requireTrue = condition => { if (!condition) { throw new Error('Invalid contour timing provenance'); } };
const positive = value => Number.isSafeInteger(value) && value > 0;
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const keys = ['stageId', 'runId', 'workflow', 'runConclusion', 'headSha', 'jobId', 'jobName', 'jobConclusion', 'jobStartedAt', 'jobCompletedAt', 'invocationId', 'startedAt', 'durationMs', 'attempt', 'sourceClean', 'nodeVersion', 'artifact', 'summarySha256', 'attemptSha256'].sort();

function deriveContourDeadlines(fixture) {
  requireTrue(fixture && isDeepStrictEqual(Object.keys(fixture).sort(), ['branch', 'capturedAt', 'event', 'margin', 'samples', 'schemaVersion']));
  requireTrue(fixture?.schemaVersion === 1 && fixture.margin === 2 && fixture.branch === 'inf/phase-01-trustworthy-baseline' && fixture.event === 'push' && date(fixture.capturedAt));
  requireTrue(Array.isArray(fixture.samples) && fixture.samples.length === 15);
  const runs = new Map();
  const revisions = new Map();
  const jobs = new Set();
  const invocations = new Set();
  for (const sample of fixture.samples) {
    requireTrue(sample && isDeepStrictEqual(Object.keys(sample).sort(), keys));
    requireTrue(stageIds.includes(sample.stageId) && positive(sample.runId) && positive(sample.jobId) && sha(sample.headSha));
    const browser = sample.stageId.startsWith('browser-');
    const shard = sample.stageId.slice(-1);
    requireTrue(sample.workflow === (browser ? 'core-integration.yml' : 'core-ci.yml'));
    requireTrue(sample.jobName === (browser ? `Browser suite ${shard}/4` : 'Dialect-sensitive specs on MySQL 8.0.45'));
    // A successful MySQL job in an otherwise failed workflow is still a real
    // measurement. It does not turn that workflow into green evidence.
    requireTrue((browser ? sample.runConclusion === 'success' : ['success', 'failure'].includes(sample.runConclusion)) && sample.jobConclusion === 'success' && sample.attempt === 1 && sample.sourceClean === true);
    requireTrue(/^v22\.\d+\.\d+$/.test(sample.nodeVersion) && positive(sample.durationMs));
    requireTrue(date(sample.startedAt) && date(sample.jobStartedAt) && date(sample.jobCompletedAt));
    const started = Date.parse(sample.startedAt);
    requireTrue(started >= Date.parse(sample.jobStartedAt) && started + sample.durationMs <= Date.parse(sample.jobCompletedAt) && Date.parse(sample.jobCompletedAt) <= Date.parse(fixture.capturedAt));
    requireTrue(typeof sample.invocationId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(sample.invocationId));
    const upload = browser ? `(?:browser|core-integration)/verify-browser-shard-${shard}` : '(?:mysql-dialect|verify-mysql-dialect|core-ci/verify-mysql-dialect)';
    const artifactPattern = new RegExp(`^ci-${sample.headSha.slice(0, 7)}/${upload}/(\\d+)-${sample.invocationId}$`);
    const reference = typeof sample.artifact === 'string' && artifactPattern.exec(sample.artifact);
    requireTrue(reference && Math.abs(Number(reference[1]) - started) <= 1000 && hash(sample.summarySha256) && hash(sample.attemptSha256));
    requireTrue(!jobs.has(sample.jobId) && !invocations.has(sample.invocationId));
    jobs.add(sample.jobId);
    invocations.add(sample.invocationId);
    const identity = `${sample.workflow}:${sample.headSha}:${sample.runConclusion}`;
    if (!runs.has(sample.runId)) { runs.set(sample.runId, {identity, stages: []}); }
    requireTrue(runs.get(sample.runId).identity === identity);
    runs.get(sample.runId).stages.push(sample.stageId);
    if (!revisions.has(sample.headSha)) { revisions.set(sample.headSha, []); }
    revisions.get(sample.headSha).push(sample.stageId);
  }
  requireTrue(runs.size === 6 && revisions.size === 3);
  for (const stages of revisions.values()) { requireTrue(isDeepStrictEqual(stages.sort(), stageIds)); }
  for (const run of runs.values()) {
    requireTrue(isDeepStrictEqual(run.stages.sort(), run.stages.includes('mysql-dialect') ? ['mysql-dialect'] : stageIds.slice(0, 4)));
  }
  // Whole job duration includes provisioning/uploads; use only the canonical
  // stage duration. Pool browser shards so scheduling differences retain slack.
  const maximum = browser => Math.max(...fixture.samples.filter(sample => sample.stageId.startsWith('browser-') === browser).map(sample => sample.durationMs));
  const deadlines = {browser: maximum(true) * fixture.margin, mysql: maximum(false) * fixture.margin};
  requireTrue(Object.values(deadlines).every(value => positive(value) && value <= 2147483647));
  return Object.freeze(deadlines);
}

module.exports = {deriveContourDeadlines};
