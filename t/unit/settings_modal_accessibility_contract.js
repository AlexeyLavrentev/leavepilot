'use strict';

const fs = require('fs');
const path = require('path');
const {expect} = require('chai');

const readView = relativePath => fs.readFileSync(
  path.join(__dirname, '..', '..', 'views', relativePath),
  'utf8'
);

describe('Settings modal accessibility contracts', function() {
  const leaveTypeModal = readView(
    path.join('partials', 'add_new_leave_type_modal.hbs')
  );
  const bankHolidaysView = readView('bankHolidays.hbs');

  it('names the Add Leave Type dialog from its visible heading', function() {
    expect(leaveTypeModal).to.include(
      'aria-labelledby="{{container_id}}_label"'
    );
    expect(leaveTypeModal).to.include(
      '<h4 class="modal-title" id="{{container_id}}_label">'
    );
    expect(leaveTypeModal).not.to.include('exampleModalLabel');
  });

  it('marks the Add Leave Type modal body as a dialog document', function() {
    expect(leaveTypeModal).to.include(
      '<div class="modal-dialog" role="document">'
    );
  });

  it('names the Add Work Calendar dialog from its visible heading', function() {
    expect(bankHolidaysView).to.match(
      /id="add_work_calendar_modal"[^>]*aria-labelledby="add_work_calendar_modal_label"/
    );
    expect(bankHolidaysView).to.include(
      '<h4 class="modal-title" id="add_work_calendar_modal_label">'
    );
  });

  it('marks the Add Work Calendar modal body as a dialog document', function() {
    expect(bankHolidaysView).to.match(
      /id="add_work_calendar_modal"[\s\S]*?<div class="modal-dialog" role="document">/
    );
  });
});
