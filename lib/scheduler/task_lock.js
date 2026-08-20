"use strict";
const { Op } = require('sequelize');

const dayjs = require('../util/date');
const os = require('os');

const DEFAULT_LOCK_TTL_MINUTES = 60;

const buildLockOwner = () => [
  os.hostname(),
  process.pid,
  Date.now(),
].join(':');

const tryAcquireTaskLock = async ({
  models,
  taskName,
  ttlMinutes,
  lockedBy,
  now,
}) => {
  const effectiveNow = dayjs.utc(now || new Date());
  const effectiveTtlMinutes = Number(ttlMinutes || DEFAULT_LOCK_TTL_MINUTES);
  const lockOwner = lockedBy || buildLockOwner();
  const lockedUntil = effectiveNow.clone().add(effectiveTtlMinutes, 'minutes').toDate();

  const existingLock = await models.ScheduledTaskLock.findOne({
    where : { task_name : taskName },
  });

  if (!existingLock) {
    try {
      const lock = await models.ScheduledTaskLock.create({
        task_name    : taskName,
        locked_until : lockedUntil,
        locked_by    : lockOwner,
      });

      return {
        acquired : true,
        lock,
        lockedBy : lockOwner,
      };
    } catch (error) {
      if (error && error.name === 'SequelizeUniqueConstraintError') {
        return {
          acquired : false,
          lock     : null,
          lockedBy : lockOwner,
        };
      }

      throw error;
    }
  }

  if (dayjs.utc(existingLock.locked_until).isAfter(effectiveNow)) {
    return {
      acquired : false,
      lock     : existingLock,
      lockedBy : lockOwner,
    };
  }

  const updateResult = await models.ScheduledTaskLock.update({
    locked_until : lockedUntil,
    locked_by    : lockOwner,
  }, {
    where : {
      task_name    : taskName,
      locked_until : { [Op.lte] : effectiveNow.toDate() },
    },
  });

  const affectedRows = Array.isArray(updateResult) ? updateResult[0] : updateResult;

  if (!affectedRows) {
    return {
      acquired : false,
      lock     : existingLock,
      lockedBy : lockOwner,
    };
  }

  const lock = await models.ScheduledTaskLock.findOne({
    where : { task_name : taskName },
  });

  return {
    acquired : true,
    lock,
    lockedBy : lockOwner,
  };
};

const releaseTaskLock = async ({
  lock,
  lockedBy,
  now,
}) => {
  if (!lock || lock.locked_by !== lockedBy) {
    return;
  }

  lock.locked_until = dayjs.utc(now || new Date()).toDate();

  await lock.save();
};

module.exports = {
  DEFAULT_LOCK_TTL_MINUTES,
  buildLockOwner,
  releaseTaskLock,
  tryAcquireTaskLock,
};
