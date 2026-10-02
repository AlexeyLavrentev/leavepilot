'use strict';

const {Op} = require('sequelize');

const STATUS_PENDING = 'pending';
const STATUS_DELIVERED = 'delivered';
const STATUS_FAILED = 'failed';

const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30000;
const PURGE_AFTER_DELIVERED_MS = 7 * 24 * 60 * 60 * 1000;
const PURGE_BATCH_LIMIT = 500;
const LAST_ERROR_MAX_LENGTH = 500;

/*
  Exponential backoff with bounded jitter (D-03): BACKOFF_BASE_MS * 2^(attempts-1)
  capped at BACKOFF_CAP_MS, plus a random component scaled to ±20% of the
  capped delay. `random` is injectable so tests get deterministic schedules;
  the default Math.random keeps concurrent sweep owners from retrying in
  lockstep. The delay is clamped into [BACKOFF_BASE_MS, BACKOFF_CAP_MS] so
  jitter can never undercut the base or exceed the cap.
*/
const nextAttemptDate = ({attempts, now, random}) => {
  const effectiveNow = now || new Date();
  const effectiveRandom = typeof random === 'function' ? random : Math.random;
  const exponent = Math.max(0, Number(attempts || 1) - 1);
  const cappedDelay = Math.min(BACKOFF_BASE_MS * Math.pow(2, exponent), BACKOFF_CAP_MS);
  const jitter = (effectiveRandom() - 0.5) * 0.4 * cappedDelay;
  const delay = Math.min(BACKOFF_CAP_MS, Math.max(BACKOFF_BASE_MS, cappedDelay + jitter));

  return new Date(effectiveNow.getTime() + delay);
};

/*
  Insert typed outbox records on the CALLER's transaction (D-01): every
  create receives the same {transaction} object unchanged, so the records
  commit or roll back together with the mutation that produced them.

  Payload policy (V10/T-04-01): references only — ids and enums. Never
  emails, rendered bodies, or tokens; rendering happens at delivery time
  from these references.
*/
const enqueue = async ({models, transaction, records, now}) => {
  const effectiveNow = now || new Date();
  const rows = (records || []).map(record => ({
    deliveryType : record.deliveryType,
    eventType    : record.eventType,
    companyId    : record.companyId,
    userId       : record.userId,
    payload      : JSON.stringify(record.payload || {}),
    status       : STATUS_PENDING,
    attempts     : 0,
    nextAttemptAt: effectiveNow,
  }));

  for (const row of rows) {
    await models.DeliveryOutbox.create(row, {transaction});
  }

  return rows.length;
};

/*
  Select due rows and lease-claim each with ONE conditional update
  `where {id, attempts: expected}` (the task_lock affected-rows guard shape —
  the only dialect-safe claim across SQLite and MySQL 8, which have no
  SELECT ... FOR UPDATE). The claim already carries attempts+1 and the
  pre-scheduled next_attempt_at, so a crash between claim and delivery
  self-heals: the row is simply due again. Statuses stay
  pending|delivered|failed — there is no in-flight state.
*/
const claimDueRecords = async ({models, now, limit, includeFailed, random}) => {
  const effectiveNow = now || new Date();
  const statusFilter = includeFailed
    ? {[Op.in]: [STATUS_PENDING, STATUS_FAILED]}
    : STATUS_PENDING;

  const due = await models.DeliveryOutbox.findAll({
    where : {
      status         : statusFilter,
      nextAttemptAt : {[Op.lte]: effectiveNow},
    },
    order : [['id', 'ASC']],
    limit,
  });

  const claimed = [];

  for (const record of due) {
    const attempts = record.attempts + 1;
    const nextAttemptAt = nextAttemptDate({attempts, now: effectiveNow, random});

    const updateResult = await models.DeliveryOutbox.update({
      attempts,
      nextAttemptAt,
    }, {
      where : {
        id       : record.id,
        attempts : record.attempts,
      },
    });

    const affectedRows = Array.isArray(updateResult) ? updateResult[0] : updateResult;

    if (!affectedRows) {
      // Another sweep won the optimistic race; skip this record.
      continue;
    }

    claimed.push(Object.assign({}, record, {attempts, nextAttemptAt}));
  }

  return claimed;
};

const markDelivered = async ({models, id, now}) => {
  await models.DeliveryOutbox.update({
    status      : STATUS_DELIVERED,
    deliveredAt : now || new Date(),
  }, {
    where: {id},
  });
};

const markFailed = async ({models, id, lastError}) => {
  const boundedError = String(lastError || '').slice(0, LAST_ERROR_MAX_LENGTH);

  await models.DeliveryOutbox.update({
    status    : STATUS_FAILED,
    lastError : boundedError,
  }, {
    where: {id},
  });
};

/*
  Lazy age-based purge (D-04): delivered rows older than the horizon only,
  in a bounded batch, destroyed by id list. Pending and failed rows are
  never deleted — failed rows are the operator's recovery queue (D-08).
*/
const purgeDelivered = async ({models, now, olderThanMs, limit}) => {
  const effectiveNow = now || new Date();
  const horizon = new Date(
    effectiveNow.getTime() - (olderThanMs || PURGE_AFTER_DELIVERED_MS)
  );
  const batchLimit = limit || PURGE_BATCH_LIMIT;

  const stale = await models.DeliveryOutbox.findAll({
    where : {
      status      : STATUS_DELIVERED,
      deliveredAt : {[Op.lt]: horizon},
    },
    order : [['id', 'ASC']],
    limit : batchLimit,
  });

  if (!stale.length) {
    return 0;
  }

  const ids = stale.map(record => record.id);

  return models.DeliveryOutbox.destroy({
    where: {id: ids},
  });
};

module.exports = {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  LAST_ERROR_MAX_LENGTH,
  PURGE_AFTER_DELIVERED_MS,
  PURGE_BATCH_LIMIT,
  STATUS_DELIVERED,
  STATUS_FAILED,
  STATUS_PENDING,
  claimDueRecords,
  enqueue,
  markDelivered,
  markFailed,
  nextAttemptDate,
  purgeDelivered,
};
