"use strict";

const dayjs = require('../../util/date');

const getMinimumLeaveRequirementStatus = async ({ user, leaveType, year }) => {
  if (!user || !leaveType) {
    return null;
  }

  const minimumDays = Number(leaveType.minimum_consecutive_days || 0);

  if (!minimumDays || minimumDays <= 0) {
    return null;
  }

  const targetYear = dayjs.utc(year || dayjs.utc());

  await user.promise_schedule_I_obey();

  const leaves = await user.promise_my_active_leaves({ year: targetYear });

  const longestLeave = leaves
    .filter(leave => `${leave.leaveTypeId}` === `${leaveType.id}`)
    .reduce((longest, leave) => {
      const leaveDays = leave.get_deducted_days_number({
        ignore_allowance : true,
        leave_type       : leave.leave_type || leaveType,
        user             : leave.user || user,
        year             : targetYear.format('YYYY'),
      });

      return Math.max(longest, leaveDays);
    }, 0);

  if (longestLeave >= minimumDays) {
    return null;
  }

  return {
    requiredDays : minimumDays,
    year         : targetYear.format('YYYY'),
  };
};

module.exports = {
  getMinimumLeaveRequirementStatus,
};
