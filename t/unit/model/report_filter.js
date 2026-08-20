"use strict";

const expect = require("chai").expect;
const dayjs = require("../../../lib/util/date");
const validator = require("../../../lib/util/validator");
const { parseReportFilters } = require("../../../lib/model/report_filter");

describe("Report filter validation", function() {
  const defaults = {
    defaultStartDate: dayjs.utc("2026-06-01"),
    defaultEndDate: dayjs.utc("2026-06-30"),
    dayjs,
    validator,
  };

  it("rejects invalid, reversed, and cross-year ranges", function() {
    expect(parseReportFilters({
      ...defaults,
      query: { start_date: "bad" },
    }).error).to.equal("invalid_date");
    expect(parseReportFilters({
      ...defaults,
      query: { start_date: "2026-07-01", end_date: "2026-06-01" },
    }).error).to.equal("invalid_date_range");
    expect(parseReportFilters({
      ...defaults,
      query: { start_date: "2026-12", end_date: "2027-01" },
      requireSingleYear: true,
    }).error).to.equal("cross_year_range");
  });

  it("rejects invalid entity filters and accepts valid ones", function() {
    expect(parseReportFilters({
      ...defaults,
      query: { department: "x" },
    }).error).to.equal("invalid_department");
    expect(parseReportFilters({
      ...defaults,
      query: { leave_type: "x" },
      includeLeaveType: true,
    }).error).to.equal("invalid_leave_type");

    const result = parseReportFilters({
      ...defaults,
      query: {
        start_date: "2026-06-01",
        end_date: "2026-06-30",
        department: "2",
        leave_type: "3",
      },
      includeLeaveType: true,
    });
    expect(result.error).to.equal(undefined);
    expect(result.departmentId).to.equal("2");
    expect(result.leaveTypeId).to.equal("3");
  });
});
