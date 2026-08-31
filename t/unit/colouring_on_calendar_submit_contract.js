'use strict';

const fs = require('fs');
const path = require('path');
const {expect} = require('chai');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'integration', 'leave_type', 'colouring_on_calendar.js'),
  'utf8'
);
const bookingBlocks = source.match(/it\("Add absence:[\s\S]*?\n\s{2}\}\);/g) || [];

describe('calendar colouring leave submit contract', function(){
  it('scopes every Add absence submit to the visible booking modal', function(){
    expect(bookingBlocks).to.have.length(5);

    bookingBlocks.forEach(block => {
      expect(block.match(/submit_form_func\(\{/g) || []).to.have.length(1);
      expect(block).to.contain("submit_button_selector : '#book_leave_modal button[type=\"submit\"]'");
      expect(block).to.contain("modal_selector : '#book_leave_modal'");
    });
  });
});
