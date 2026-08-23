'use strict';

const dayjs = require('../util/date');
const {Op} = require('sequelize');
const features = require('../features');

const companyQueues = new WeakMap();

const isActiveEndDate = endDate => (
  !endDate || dayjs.utc(endDate).isSameOrAfter(dayjs.utc().startOf('day'))
);

const getSeatLimit = () => {
  const status = features.getLicenseStatus();
  return status.valid && Number.isSafeInteger(status.maxActiveUsers)
    ? status.maxActiveUsers
    : null;
};

const createSeatLimitError = limit => {
  const error = new Error('Active user limit of ' + limit + ' has been reached.');
  error.code = 'LICENSE_SEAT_LIMIT_EXCEEDED';
  error.show_to_user = true;
  error.maxActiveUsers = limit;
  error.tom_error = true;
  error.user_error_message = error.message;
  return error;
};

const countActiveUsers = ({User, companyId, transaction}) => User.count({
  where: Object.assign({companyId}, User.get_active_user_filter()),
  transaction,
});

const userConsumesNewSeat = user => {
  if (!getSeatLimit() || !isActiveEndDate(user.getDataValue('end_date'))) {
    return false;
  }

  const previous = user._previousDataValues || {};
  return user.isNewRecord
    || String(previous.companyId) !== String(user.companyId)
    || !isActiveEndDate(previous.end_date);
};

const serializeCompany = async ({sequelize, companyId, operation}) => {
  let queues = companyQueues.get(sequelize);
  if (!queues) {
    queues = new Map();
    companyQueues.set(sequelize, queues);
  }

  const key = String(companyId);
  const previous = queues.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  queues.set(key, current);

  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (queues.get(key) === current) {queues.delete(key);}
  }
};

const withCompanySeatLocks = ({sequelize, Company, companyIds, transaction, operation}) => {
  const ids = Array.from(new Set(companyIds.map(String))).sort();

  const runWithDatabaseLocks = async activeTransaction => {
    for (const companyId of ids) {
      const company = await Company.findByPk(companyId, {
        attributes: ['id'],
        transaction: activeTransaction,
        lock: activeTransaction.LOCK && activeTransaction.LOCK.UPDATE,
      });
      if (!company) {throw new Error('Cannot enforce seat limit for missing company ' + companyId);}
    }
    return operation(activeTransaction);
  };

  const runTransaction = () => transaction
    ? runWithDatabaseLocks(transaction)
    : sequelize.transaction(runWithDatabaseLocks);

  const runQueued = ids.reduceRight((next, companyId) => (
    () => serializeCompany({sequelize, companyId, operation: next})
  ), runTransaction);

  return runQueued();
};

const assertUserSaveWithinLimit = async ({User, user, options}) => {
  const limit = getSeatLimit();
  if (!limit || !isActiveEndDate(user.getDataValue('end_date'))) {
    return;
  }

  const previousEndDate = user._previousDataValues && user._previousDataValues.end_date;
  const previousCompanyId = user._previousDataValues && user._previousDataValues.companyId;
  const wasActiveInCompany = !user.isNewRecord
    && String(previousCompanyId) === String(user.companyId)
    && isActiveEndDate(previousEndDate);

  if (wasActiveInCompany) {
    return;
  }

  const activeCount = await countActiveUsers({
    User,
    companyId: user.companyId,
    transaction: options && options.transaction,
  });

  if (activeCount >= limit) {
    throw createSeatLimitError(limit);
  }
};

const assertBulkSaveWithinLimit = async ({User, users, options}) => {
  const limit = getSeatLimit();
  if (!limit || !users.length) {
    return;
  }

  const transaction = options && options.transaction;
  const groups = users.reduce((result, user) => {
    const companyId = user.companyId;
    result[companyId] = result[companyId] || [];
    result[companyId].push(user);
    return result;
  }, {});

  for (const companyId of Object.keys(groups)) {
    const proposed = groups[companyId];
    const existingIds = proposed.map(user => user.id).filter(Boolean);
    const existing = existingIds.length
      ? await User.findAll({
        attributes: ['id', 'end_date'],
        where: {id: {[Op.in]: existingIds}, companyId},
        transaction,
      })
      : [];
    const existingById = new Map(existing.map(user => [String(user.id), user]));
    const currentCount = await countActiveUsers({User, companyId, transaction});
    let projectedCount = currentCount;

    proposed.forEach(user => {
      const current = existingById.get(String(user.id));
      if (current && isActiveEndDate(current.getDataValue('end_date'))) {
        projectedCount -= 1;
      }
      if (isActiveEndDate(user.getDataValue('end_date'))) {
        projectedCount += 1;
      }
    });

    if (projectedCount > limit) {
      throw createSeatLimitError(limit);
    }
  }
};

module.exports = {
  assertBulkSaveWithinLimit,
  assertUserSaveWithinLimit,
  createSeatLimitError,
  getSeatLimit,
  isActiveEndDate,
  userConsumesNewSeat,
  withCompanySeatLocks,
};
