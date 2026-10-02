'use strict';

const deliveryOutbox = require('../model/delivery_outbox');
const taskLock = require('./task_lock');

const LOCK_TASK_NAME = 'leave_delivery_outbox';
const DEFAULT_TICK_MS = 30000;
// Calibrated to the 30s tick (~2x tick + sweep): the reminder scheduler's
// 60-minute default would let an expired-lock overlap run for an hour,
// while a 1-minute TTL bounds double-sweep overlap to one tick. The
// per-record optimistic claim keeps any overlap harmless (at-least-once).
// Rationale is recorded in the runtime_timings policy during 04-04.
const LOCK_TTL_MINUTES = 1;
const MAX_ATTEMPTS = 5;

// Default executor resolution goes through the edition registry (D-09):
// Community registers 'email' and 'edition_event'; Premium registers its own
// types through the same seam. Community never imports Premium code.
const defaultResolveExecutor = deliveryType => {
  const registry = require('../edition').getRegistry();
  return registry ? registry.getDeliveryExecutor(deliveryType) : null;
};

/*
  One record's failure path (D-03/D-08): the red event carries ids/type and
  the error MESSAGE only — never the payload, a raw error object, or a
  stack. At MAX_ATTEMPTS the record is terminally failed and the operator
  learns through delivery_exhausted; below it, the claim has already
  pre-scheduled the next attempt, so nothing else happens here.
*/
const handleFailedAttempt = async ({models, logger, record, errorMessage, eventName}) => {
  logger.error(eventName, {
    id         : record.id,
    type       : record.deliveryType,
    event_type : record.eventType,
    attempts   : record.attempts,
    err        : errorMessage,
  });

  if (record.attempts >= MAX_ATTEMPTS) {
    await deliveryOutbox.markFailed({
      models,
      id        : record.id,
      lastError : errorMessage,
    });

    logger.error('delivery_exhausted', {
      id         : record.id,
      type       : record.deliveryType,
      event_type : record.eventType,
      attempts   : record.attempts,
    });
  }
};

/*
  Deterministic single sweep: acquire the ScheduledTaskLocks task
  (leave_delivery_outbox, D-05 — one sweep owner per database), claim due
  records, dispatch each through the executor resolved for its
  delivery_type, fix delivered/failed status, then opportunistically purge
  old delivered rows (D-04). Returns commit-free counts for callers and
  tests; used by runOnce, the D-11 re-drive CLI (04-03), and the worker
  tick below.
*/
const runDeliveryOutboxOnce = async ({
  models,
  logger,
  includeFailed,
  limit,
  resolveExecutor,
  now,
  random,
}) => {
  const effectiveLogger = logger || require('../logger');
  const effectiveResolveExecutor = resolveExecutor || defaultResolveExecutor;

  const lockResult = await taskLock.tryAcquireTaskLock({
    models,
    taskName   : LOCK_TASK_NAME,
    ttlMinutes : LOCK_TTL_MINUTES,
  });

  if (!lockResult.acquired) {
    return {
      skipped  : true,
      claimed  : 0,
      delivered: 0,
      failed   : 0,
      purged   : 0,
    };
  }

  let delivered = 0;
  let failed = 0;

  try {
    const claimed = await deliveryOutbox.claimDueRecords({
      models,
      now,
      limit,
      includeFailed,
      random,
    });

    for (const record of claimed) {
      const executor = effectiveResolveExecutor(record.deliveryType);

      if (!executor || typeof executor.deliver !== 'function') {
        // D-09 fallback: a type with no executor is a failed attempt with
        // its own red event — bounded retries, never a throw past the sweep.
        failed += 1;
        await handleFailedAttempt({
          models,
          logger      : effectiveLogger,
          record,
          eventName   : 'delivery_executor_missing',
          errorMessage: 'No delivery executor registered for type ' + record.deliveryType,
        });
        continue;
      }

      try {
        await executor.deliver({record, models});
        await deliveryOutbox.markDelivered({models, id: record.id, now});
        delivered += 1;
      } catch (error) {
        failed += 1;
        await handleFailedAttempt({
          models,
          logger      : effectiveLogger,
          record,
          eventName   : 'delivery_attempt_failed',
          errorMessage: error && error.message || String(error),
        });
      }
    }

    const purged = await deliveryOutbox.purgeDelivered({models, now});

    effectiveLogger.debug('delivery_sweep_completed', {
      claimed        : claimed.length,
      delivered,
      failed,
      purged,
      include_failed : !!includeFailed,
    });

    return {
      skipped  : false,
      claimed  : claimed.length,
      delivered,
      failed,
      purged,
    };
  } finally {
    await taskLock.releaseTaskLock({
      lock     : lockResult.lock,
      lockedBy : lockResult.lockedBy,
    });
  }
};

/*
  Always-on worker (D-02/D-05): unlike the reminder scheduler there is NO
  feature flag — undelivered outbox rows must never silently accumulate.
  The first sweep runs immediately as the startup catch-up pass and
  re-arms failed records (D-11 restart re-arm); the periodic ticks sweep
  pending records only. Delivery is never scheduled from an afterCommit
  callback — the worker polls the table, because afterCommit fires even
  when a commit failed.
*/
const startDeliveryOutboxWorker = ({models, logger, tickMs, limit, resolveExecutor}) => {
  const effectiveLogger = logger || require('../logger');
  const effectiveTickMs = tickMs || DEFAULT_TICK_MS;

  let timeoutId = null;
  let isStopped = false;
  let activeJob = Promise.resolve();

  const sweep = ({includeFailed}) => runDeliveryOutboxOnce({
    models,
    logger         : effectiveLogger,
    includeFailed,
    limit,
    resolveExecutor,
  }).catch(error => {
    // A failed sweep must never kill the tick loop; the failure is red and
    // the next tick retries the same durable table state.
    effectiveLogger.error('delivery_sweep_failed', {
      err: error && error.message || String(error),
    });
  });

  const scheduleNextRun = () => {
    if (isStopped) {
      return;
    }

    timeoutId = setTimeout(function() {
      timeoutId = null;
      if (isStopped) { return activeJob; }
      activeJob = sweep({includeFailed: false}).finally(() => {
        scheduleNextRun();
      });
      return activeJob;
    }, effectiveTickMs);

    if (timeoutId && typeof timeoutId.unref === 'function') {
      timeoutId.unref();
    }
  };

  activeJob = sweep({includeFailed: true}).finally(() => {
    scheduleNextRun();
  });

  return {
    stop: function() {
      isStopped = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      return activeJob;
    },
  };
};

module.exports = {
  DEFAULT_TICK_MS,
  LOCK_TASK_NAME,
  LOCK_TTL_MINUTES,
  MAX_ATTEMPTS,
  runDeliveryOutboxOnce,
  startDeliveryOutboxWorker,
};
