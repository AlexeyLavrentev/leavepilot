'use strict';

const fs = require('fs');
const path = require('path');
const {expect} = require('chai');

const root = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

describe('overlapping booking successful submit contract', function(){
  const scenario = read('t', 'integration', 'leave_request', 'ovelapping_bookings.js');
  const app = read('app.js');
  const modal = read('views', 'partials', 'book_leave_modal.hbs');
  const calendarRoute = read('lib', 'route', 'calendar.js');
  const start = scenario.indexOf('it("Request new leave"');
  const end = scenario.indexOf('it("Check that all days are marked as pended"', start);
  const successfulRequest = scenario.slice(start, end);

  it('uses same-document completion and waits for the leave modal to close', function(){
    expect(app).to.match(/requested_path\s*=\s*req\.originalUrl/);
    expect(modal).to.match(/name="redirect_back_to"\s+value="\{\{requested_path\}\}"/);
    expect(calendarRoute).to.match(/flash_message\(req\.t\('calendar\.messages\.leaveAdded'\)\)[\s\S]*?redirect_with_session\([\s\S]*?req\.body\.redirect_back_to/);
    expect(successfulRequest).to.match(/submit_form_func\(\{[\s\S]*?message\s*:\s*\/New leave request was added\/[\s\S]*?expect_navigation\s*:\s*false[\s\S]*?modal_selector\s*:\s*['"]#book_leave_modal['"][\s\S]*?\}\)/);
    expect(successfulRequest).not.to.match(/expect_navigation\s*:\s*true/);
  });
});
