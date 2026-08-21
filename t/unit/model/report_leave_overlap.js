'use strict';

const {expect} = require('chai');
const dayjs = require('../../../lib/util/date');
const {filterLeaves} = require('../../../lib/model/Report');

const leave = (start, end) => ({
  get_start_leave_day: () => ({date: start}),
  get_end_leave_day: () => ({date: end}),
});

describe('Report leave interval filtering', function() {
  const filter = filterLeaves({
    startDate: dayjs.utc('2026-07-10'),
    endDate: dayjs.utc('2026-07-10'),
  });

  it('includes a leave spanning the complete report interval', function() {
    expect(filter(leave('2026-07-01', '2026-07-20'))).to.equal(true);
  });

  it('includes leaves touching either report boundary', function() {
    expect(filter(leave('2026-07-10', '2026-07-12'))).to.equal(true);
    expect(filter(leave('2026-07-08', '2026-07-10'))).to.equal(true);
  });

  it('excludes leaves entirely before or after the report interval', function() {
    expect(filter(leave('2026-07-01', '2026-07-09'))).to.equal(false);
    expect(filter(leave('2026-07-11', '2026-07-20'))).to.equal(false);
  });
});
