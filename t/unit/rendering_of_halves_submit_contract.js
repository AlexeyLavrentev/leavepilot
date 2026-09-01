'use strict';

const fs = require('fs');
const path = require('path');
const {expect} = require('chai');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'integration', 'leave_request', 'rendering_of_halves.js'),
  'utf8'
);
const bookingBlocks = source.match(/it\("Request [\s\S]*?\n\s{2}\}\);/g) || [];

describe('partial-day leave submit contract', function(){
  it('scopes each successful booking submit to the visible leave modal', function(){
    expect(bookingBlocks).to.have.length(4);

    bookingBlocks.forEach(block => {
      expect(block.match(/submit_form_func\(\{/g) || []).to.have.length(1);
      expect(block).to.contain("submit_button_selector : '#book_leave_modal button[type=\"submit\"]'");
      expect(block).to.contain("modal_selector : '#book_leave_modal'");
      expect(block).to.contain('message : /New leave request was added/');
    });
  });
});
