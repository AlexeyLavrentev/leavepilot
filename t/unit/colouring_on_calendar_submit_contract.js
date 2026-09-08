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
  for (const teamView of [false, true]) {
    for (const wrongColour of [false, true]) {
      it(`${teamView ? 'team view' : 'calendar'} ${wrongColour ? 'rejects colour 10 in place of colour 1' : 'accepts the exact half-day colours'}`, async function(){
        const assert = require('node:assert/strict');
        const vm = require('node:vm');
        const filename = path.resolve('t/integration/leave_type/colouring_on_calendar.js');
        const localRequire = require('node:module').createRequire(filename);
        const tests = new Map();
        const colours = {'1_2nd': 3, '2_1st': 3, '2_2nd': 1, '8_1st': 1,
          '13_2nd': 3, '14_1st': 3, '14_2nd': 1, '15_1st': 1};
        const driver = {findElement: async locator => ({getAttribute: async () => {
          const [, day, half] = /day_(\d+)\.half_(1st|2nd)/.exec(locator.value);
          const colour = colours[`${day}_${half}`];
          return colour ? `calendar_cell leave_type_color_${wrongColour && colour === 1 ? 10 : colour}` : 'calendar_cell';
        }})};
        vm.runInNewContext(source, {
          require: name => {
            if (name === '../../lib/config') {
              return {get_application_host: () => 'http://example.test/', get_execution_timeout: () => 1000};
            }
            if (name.startsWith('../../lib/')) { return async () => ({driver}); }
            return localRequire(name);
          },
          describe: (_title, callback) => callback.call({timeout() {}}),
          it: (title, callback) => tests.set(title, callback),
          after() {},
        }, {filename});
        const invoke = title => new Promise((resolve, reject) => tests.get(title)(error => error ? reject(error) : resolve()));
        await invoke('Performing registration process');
        const title = teamView ? 'Go to Team view page and ensure that all half a day cells have correct color classes'
          : 'Go to callendar page and ensure that all half days cells have correct color classes';
        if (wrongColour) { await assert.rejects(invoke(title), /to match/); }
        else { await invoke(title); }
      });
    }
  }

  it('scopes every Add absence submit to the visible booking modal', function(){
    expect(bookingBlocks).to.have.length(5);

    bookingBlocks.forEach(block => {
      expect(block.match(/submit_form_func\(\{/g) || []).to.have.length(1);
      expect(block).to.contain("submit_button_selector : '#book_leave_modal button[type=\"submit\"]'");
      expect(block).to.contain("modal_selector : '#book_leave_modal'");
    });
  });
});
