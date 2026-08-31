'use strict';

const fs = require('fs');
const path = require('path');
const {expect} = require('chai');

const root = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

describe('overlapping half-day final successful submit contract', function(){
  const scenario = read('t', 'integration', 'leave_request', 'ovelapping_bookings_halfs.js');
  const calendarRoute = read('lib', 'route', 'calendar.js');
  const finalStart = scenario.indexOf('it("And create correct one"');
  const finalEnd = scenario.indexOf('it("Check that all days are marked as pended"', finalStart);
  const finalSuccess = scenario.slice(finalStart, finalEnd);

  it('follows the successful booking redirect and closes its leave modal', function(){
    expect(calendarRoute).to.match(/flash_message\(req\.t\('calendar\.messages\.leaveAdded'\)\)[\s\S]*?redirect_with_session/);
    expect(finalSuccess).to.match(/submit_form_func\(\{[\s\S]*?message\s*:\s*\/New leave request was added\/[\s\S]*?expect_navigation\s*:\s*true[\s\S]*?modal_selector\s*:\s*['"]#book_leave_modal['"][\s\S]*?\}\)/);
    expect(finalSuccess).not.to.match(/expect_navigation\s*:\s*false/);
  });
});
