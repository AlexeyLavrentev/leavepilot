'use strict';

const expect = require('chai').expect;
const dayjs = require('../../../../lib/util/date');
const model = require('../../../../lib/model/db');
const { getMinimumLeaveRequirementStatus } = require('../../../../lib/model/leave/minimum_leave_requirement');

describe('Minimum consecutive leave requirement', function(){
  it('counts only leave days inside the checked calendar year', async function(){
    const leaveType = model.LeaveType.build({
      id : 1,
      name : 'Annual leave',
      use_allowance : true,
      deduction_unit : 'calendar_days',
      minimum_consecutive_days : 2,
    });
    const user = model.User.build({id : 10});
    user.company = {bank_holidays : []};
    user.department = {};
    user.cached_schedule = {
      is_it_working_day : function(){ return true; },
    };

    const leave = model.Leave.build({
      status : model.Leave.status_approved(),
      leaveTypeId : leaveType.id,
      date_start : '2025-12-31',
      date_end : '2026-01-01',
      day_part_start : model.Leave.leave_day_part_all(),
      day_part_end : model.Leave.leave_day_part_all(),
    });
    leave.leave_type = leaveType;
    leave.user = user;

    user.promise_schedule_I_obey = function(){
      return Promise.resolve(user.cached_schedule);
    };
    user.promise_my_active_leaves = function(){
      return Promise.resolve([leave]);
    };

    const status = await getMinimumLeaveRequirementStatus({
      user,
      leaveType,
      year : dayjs.utc('2026-01-01'),
    });

    expect(status).to.deep.equal({requiredDays : 2, year : '2026'});
  });
});
