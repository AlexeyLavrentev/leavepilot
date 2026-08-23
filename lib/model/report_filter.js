"use strict";

const hasValue = value =>
  value !== undefined && value !== null && String(value).trim() !== "";

function parseReportFilters({
  query,
  defaultStartDate,
  defaultEndDate,
  dayjs,
  validator,
  requireSingleYear = false,
  includeLeaveType = false,
}) {
  const rawStartDate = query.start_date;
  const rawEndDate = query.end_date;
  const rawDepartment = query.department;
  const rawLeaveType = query.leave_type;

  if (
    (hasValue(rawStartDate) && !validator.isDate(rawStartDate))
    || (hasValue(rawEndDate) && !validator.isDate(rawEndDate))
  ) {
    return { error: "invalid_date" };
  }

  if (hasValue(rawDepartment) && !validator.isNumeric(rawDepartment)) {
    return { error: "invalid_department" };
  }

  if (
    includeLeaveType
    && hasValue(rawLeaveType)
    && !validator.isNumeric(rawLeaveType)
  ) {
    return { error: "invalid_leave_type" };
  }

  const startDate = hasValue(rawStartDate)
    ? dayjs.utc(rawStartDate)
    : defaultStartDate.clone();
  const endDate = hasValue(rawEndDate)
    ? dayjs.utc(rawEndDate)
    : defaultEndDate.clone();

  if (endDate.isBefore(startDate, "day")) {
    return { error: "invalid_date_range" };
  }

  if (requireSingleYear && startDate.year() !== endDate.year()) {
    return { error: "cross_year_range" };
  }

  return {
    startDate,
    endDate,
    departmentId: hasValue(rawDepartment) ? rawDepartment : null,
    leaveTypeId: includeLeaveType && hasValue(rawLeaveType) ? rawLeaveType : null,
  };
}

module.exports = {
  parseReportFilters,
};
