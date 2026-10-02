'use strict';

/*
  releaseTaskLock used to refresh locked_until through an unconditional
  instance save() guarded only by a stale in-memory locked_by comparison. A
  worker that ran past the TTL therefore refreshed the lock another worker had
  legitimately re-acquired, and a third worker could start the task while the
  second was still running.

  These assert the compare-and-set semantics: a stale release is a no-op
  against a lock that changed hands, and a release by the current owner still
  frees the lock for the next run.
*/

const expect = require('chai').expect;
const httpAgent = require('../../lib/http_agent');
const taskLock = require('../../../lib/scheduler/task_lock');

describe('Task lock release', function() {

  this.timeout(30000);

  let models;

  before(async function() {
    await httpAgent.ready();
    models = httpAgent.getApp().get('db_model');
  });

  after(async function() {
    await httpAgent.release();
  });

  it('does not refresh a lock that has been re-acquired by another worker', async function() {
    const first = await taskLock.tryAcquireTaskLock({models, taskName: 'release-cas-test', lockedBy: 'worker-A'});
    expect(first.acquired, 'worker A acquires first').to.equal(true);

    // A runs past the TTL: expiry lets worker B take over via the atomic path.
    await models.ScheduledTaskLock.update(
      {locked_until: new Date(Date.now() - 1000)},
      {where: {task_name: 'release-cas-test'}},
    );
    const second = await taskLock.tryAcquireTaskLock({models, taskName: 'release-cas-test', lockedBy: 'worker-B'});
    expect(second.acquired, 'worker B re-acquires after expiry').to.equal(true);

    // A's late release holds a stale snapshot; the conditional UPDATE must
    // match zero rows and leave B's lock alone.
    await taskLock.releaseTaskLock({lock: first.lock, lockedBy: first.lockedBy});

    const row = await models.ScheduledTaskLock.findOne({where: {task_name: 'release-cas-test'}});
    expect(row.locked_by).to.equal('worker-B');
    expect(row.locked_until.getTime(), "B's lock was not refreshed by A's stale release")
      .to.equal(second.lock.locked_until.getTime());

    const third = await taskLock.tryAcquireTaskLock({models, taskName: 'release-cas-test', lockedBy: 'worker-C'});
    expect(third.acquired, 'C stays blocked while B holds the lock').to.equal(false);
  });

  it('frees the lock when the current owner releases it', async function() {
    const first = await taskLock.tryAcquireTaskLock({models, taskName: 'release-cas-free', lockedBy: 'worker-A'});
    expect(first.acquired).to.equal(true);

    await taskLock.releaseTaskLock({lock: first.lock, lockedBy: first.lockedBy});

    const next = await taskLock.tryAcquireTaskLock({models, taskName: 'release-cas-free', lockedBy: 'worker-B'});
    expect(next.acquired, 'the lock is reusable by the next run').to.equal(true);
  });

});
