'use strict';

const fs = require('fs');
const path = require('path');
const expect = require('chai').expect;

const read = (...p) => fs.readFileSync(path.join(__dirname, '../../..', ...p), 'utf8');

const calendarSource = read('lib', 'route', 'calendar.js');
const leaveModelSource = read('lib', 'model', 'leave', 'index.js');
const modalSource = read('views', 'partials', 'book_leave_modal.hbs');
const appSource = read('app.js');
const clientSource = read('public', 'js', 'leave_forecast.js');

describe('Leave balance forecast', function() {

  it('model exposes a forecastLeaveBalance helper', function() {
    expect(leaveModelSource).to.match(/function forecastLeaveBalance\(/);
    expect(leaveModelSource).to.match(/module\.exports\s*=\s*\{[\s\S]*forecastLeaveBalance/);
  });

  it('forecast helper reuses the allowance/deduction calculation without saving', function() {
    // Builds an in-memory leave (never .save()) and reuses the same deduction
    // and allowance methods the booking validator relies on.
    expect(leaveModelSource).to.match(/Models\.Leave\.build\(/);
    expect(leaveModelSource).to.not.match(/candidate_leave\.save\(/);
    expect(leaveModelSource).to.match(/promise_allowance/);
    expect(leaveModelSource).to.match(/get_deducted_days_number/);
  });

  it('route registers a JSON forecast endpoint', function() {
    expect(calendarSource).to.match(/router\.post\(\s*'\/leave-balance-forecast\/'/);
    expect(calendarSource).to.match(/forecastLeaveBalance\(/);
    expect(calendarSource).to.match(/res\.json\(/);
  });

  it('forecast route does not pollute session flash with validation errors', function() {
    // The booking POST handler uses flash_error for validation; the forecast
    // endpoint must stay silent and answer purely over JSON.
    const start = calendarSource.indexOf("'/leave-balance-forecast/'");
    const after = calendarSource.indexOf('\nrouter.', start);
    const forecastBlock = calendarSource.slice(start, after === -1 ? undefined : after);
    expect(forecastBlock).to.not.match(/flash_error/);
  });

  it('modal renders a forecast container wired to the endpoint', function() {
    expect(modalSource).to.match(/class="book-leave-forecast/);
    expect(modalSource).to.match(/data-forecast-url="\/calendar\/leave-balance-forecast\/"/);
    expect(modalSource).to.match(/data-tpl-summary=/);
  });

  /*
    It used to be linked on every response, which meant a logged-out visitor
    downloaded it along with the date picker it depends on. It is now linked for
    an authenticated request only — the modal it serves does not render without
    a session either. lib/middleware/page_assets.js owns that decision, and
    t/unit/page_assets.js covers both directions of the gate.
  */
  it('forecast client script is linked for an authenticated page', function() {
    const pageAssets = require('../../../lib/middleware/page_assets');
    const res = {locals: {}};

    pageAssets.attachPageAssets({user: {id: 1}}, res, function() {});

    expect(res.locals.custom_java_script).to.include('/js/leave_forecast.js');
  });

  it('client posts with the CSRF header and debounces requests', function() {
    expect(clientSource).to.match(/X-CSRF-Token/);
    expect(clientSource).to.match(/setTimeout/);
    // Stale responses must be ignored when a newer change supersedes them.
    expect(clientSource).to.match(/requestSeq/);
  });
});
