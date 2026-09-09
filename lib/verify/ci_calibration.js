'use strict';

const {isDeepStrictEqual} = require('util');
const requireTrue = condition => { if (!condition) { throw new Error('Inconsistent CI calibration identity'); } };
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const workflows = {'core-ci.yml': 'coreCi', 'core-integration.yml': 'coreIntegration'};

function validatePublicResult(name, result, selection) {
  const key = workflows[name];
  requireTrue(key && selection && selection.repository === 'AlexeyLavrentev/timeoff');
  requireTrue(typeof selection.branch === 'string' && selection.branch.length > 0 && /^[0-9a-f]{40}$/.test(selection.headSha));
  requireTrue(selection.event === 'push' && positiveId(selection.runIds?.[key]));
  const endpoint = `https://api.github.com/repos/${selection.repository}/actions/workflows/${name}/runs?branch=${encodeURIComponent(selection.branch)}&event=push&status=completed&per_page=20`;
  requireTrue(result?.workflow === name && result.endpoint === endpoint && result.result === 'available');
  const evidence = result.evidence;
  requireTrue(evidence && evidence.workflow === name && evidence.repository === selection.repository && evidence.branch === selection.branch && evidence.headSha === selection.headSha && evidence.event === selection.event);
  requireTrue(evidence.status === 'completed' && evidence.conclusion === 'success' && evidence.runId === selection.runIds[key]);
  // The repository was renamed; only the recorded old/new names are aliases.
  requireTrue(['timeoff', 'leavepilot'].some(repo => evidence.sourceUrl === `https://github.com/AlexeyLavrentev/${repo}/actions/runs/${evidence.runId}`));
  const capturedAt = Date.parse(evidence.capturedAt);
  requireTrue(typeof evidence.capturedAt === 'string' && Number.isFinite(capturedAt) && Array.isArray(evidence.jobs));
  const expectedNames = key === 'coreCi'
    ? ['Dialect-sensitive specs on MySQL 8.0.45']
    : [1, 2, 3, 4].map(shard => `Browser suite ${shard}/4`);
  requireTrue(evidence.jobs.length === expectedNames.length && evidence.jobs.every(job => job && positiveId(job.id)));
  requireTrue(new Set(evidence.jobs.map(job => job.id)).size === evidence.jobs.length);
  requireTrue(isDeepStrictEqual(evidence.jobs.map(job => job.name).sort(), expectedNames));
  for (const job of evidence.jobs) {
    const startedAt = Date.parse(job.startedAt);
    const completedAt = Date.parse(job.completedAt);
    requireTrue(typeof job.startedAt === 'string' && typeof job.completedAt === 'string' && Number.isFinite(startedAt) && completedAt > startedAt && completedAt <= capturedAt && job.durationMs === completedAt - startedAt);
  }
}

function validateCiCalibration(external) {
  for (const [name, key] of Object.entries(workflows)) {
    validatePublicResult(name, external?.publicProbe?.[key], external?.selection);
  }
  requireTrue(new Set(Object.values(external.selection.runIds)).size === 2);
  const jobs = Object.values(workflows).flatMap(key => external.publicProbe[key].evidence.jobs);
  requireTrue(new Set(jobs.map(job => job.id)).size === jobs.length);
}

module.exports = {validatePublicResult, validateCiCalibration};
