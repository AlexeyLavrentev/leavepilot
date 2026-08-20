"use strict";

const dayjs = require('../util/date');

const DAY_TYPE_NON_WORKING = 'non_working';
const DAY_TYPE_WORKING = 'working';

const dayKey = day => dayjs.utc(day.date).format('YYYY-MM-DD');

const getDaysForDepartment = ({bankHolidays, department}) => {
  const workCalendarId = department && department.WorkCalendarId;
  const daysByDate = {};

  (bankHolidays || [])
    .filter(day => !day.workCalendarId)
    .forEach(day => { daysByDate[dayKey(day)] = day; });

  if (workCalendarId) {
    (bankHolidays || [])
      .filter(day => String(day.workCalendarId) === String(workCalendarId))
      .forEach(day => { daysByDate[dayKey(day)] = day; });
  }

  return Object.keys(daysByDate)
    .map(date => daysByDate[date]);
};

const getNonWorkingDaysForDepartment = args => getDaysForDepartment(args)
  .filter(day => (day.day_type || DAY_TYPE_NON_WORKING) === DAY_TYPE_NON_WORKING);

const getWorkingDayOverridesForDepartment = args => getDaysForDepartment(args)
  .filter(day => day.day_type === DAY_TYPE_WORKING);

module.exports = {
  DAY_TYPE_NON_WORKING,
  DAY_TYPE_WORKING,
  getDaysForDepartment,
  getNonWorkingDaysForDepartment,
  getWorkingDayOverridesForDepartment,
};
