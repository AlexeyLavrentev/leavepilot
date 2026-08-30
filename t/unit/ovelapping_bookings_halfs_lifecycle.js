'use strict';

const fs = require('fs');
const path = require('path');
const {expect} = require('chai');

const root = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

describe('overlapping half-day booking lifecycle contract', function(){
  const scenario = read('t', 'integration', 'leave_request', 'ovelapping_bookings_halfs.js');
  const calendarRoute = read('lib', 'route', 'calendar.js');

  it('redirects rejected bookings before checking state and closing the modal', function(){
    expect(calendarRoute).to.match(/flash_error\(req\.t\('calendar\.messages\.leaveCreateFailed'\)\)[\s\S]*?redirect_with_session/);

    const rejectedBlocks = scenario.match(/submit_form_func\(\{[\s\S]*?message\s*:\s*\/Failed to create a leave request\/[\s\S]*?\}\)[\s\S]*?close_rejected_book_leave_modal\(driver\)/g);
    expect(rejectedBlocks, 'three rejected overlap submissions').to.have.length(3);

    rejectedBlocks.forEach(function(block){
      expect(block).to.match(/message\s*:\s*\/Failed to create a leave request\//);
      expect(block).not.to.match(/expect_navigation\s*:/);
      expect(block).to.match(/\}\)\s*\.then\(function\(\)\{\s*return check_original_booking_only\(/);
      expect(block).to.match(/check_original_booking_only\([\s\S]*?close_rejected_book_leave_modal\(driver\)/);
    });
  });

  it('keeps accepted bookings outside rejected-modal lifecycle', function(){
    const initial = scenario.slice(scenario.indexOf('it("Request new leave"'), scenario.indexOf('it("Check that all days'));
    const finalStart = scenario.indexOf('it("And create correct one"');
    const final = scenario.slice(finalStart, scenario.indexOf('it("Check that all days are marked as pended"', finalStart));

    [initial, final].forEach(function(block){
      expect(block).to.match(/message\s*:\s*\/New leave request was added\//);
      expect(block).not.to.match(/close_rejected_book_leave_modal/);
    });
  });
});
