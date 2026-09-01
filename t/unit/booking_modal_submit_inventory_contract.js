'use strict';

const {expect} = require('chai');
const fs = require('fs');
const path = require('path');

const BOOKING_CALLERS = {
  't/integration/leave_request/basic_leave_request.js': 3,
  't/integration/leave_request/cancel_basic.js': 3,
  't/integration/leave_request/create_leave_with_single_user.js': 1,
  't/integration/leave_request/leave_in_next_year.js': 1,
  't/integration/leave_request/leave_request_revoke.js': 1,
  't/integration/leave_request/ovelapping_bookings.js': 2,
  't/integration/leave_request/ovelapping_bookings_halfs.js': 5,
  't/integration/leave_request/user_auto_approve.js': 1,
  't/integration/leave_type/leave_type_auto_approve.js': 1,
  't/integration/leave_type/remove_used_leave_type.js': 1,
};

const BOOKING_MESSAGES = /message\s*:\s*\/(?:New leave request was added|Failed to create a leave request)\//;

function bookingBlocks(source) {
  return (source.match(/submit_form_func\(\{[\s\S]*?\n\s*\}\)/g) || [])
    .filter(function(block){ return BOOKING_MESSAGES.test(block); });
}

describe('booking modal submit inventory', function(){
  Object.entries(BOOKING_CALLERS).forEach(function([file, expectedCount]){
    it(file + ' keeps each proven booking submit modal-scoped', function(){
      const source = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
      const blocks = bookingBlocks(source);

      expect(blocks, 'proven booking call count').to.have.lengthOf(expectedCount);
      blocks.forEach(function(block){
        expect(block).to.match(BOOKING_MESSAGES);
        expect(block).to.match(/submit_button_selector\s*:\s*'#book_leave_modal button\[type=submit\]'/);
        expect(block).to.match(/modal_selector\s*:\s*'#book_leave_modal'/);
      });
      expect(source).not.to.match(/\.then\(function\(\)\{\s*submit_form_func\(\{/);
    });
  });
});
