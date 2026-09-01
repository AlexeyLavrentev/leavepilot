'use strict';

var expect = require('chai').expect,
    submitForm = require('../../t/lib/submit_form');

function visibleField(dataProvide) {
  return {
    isDisplayed: function(){ return Promise.resolve(true); },
    getAttribute: function(name){
      return Promise.resolve(name === 'data-provide' ? dataProvide : null);
    },
    clear: function(){ throw new Error('datepicker must not use keyboard clear'); },
    sendKeys: function(){ throw new Error('datepicker must not use keyboard input'); },
  };
}

function fieldDriver(field, result, inBookingModal) {
  var scripts = [];
  return {
    driver: {
      findElements: function(){ return Promise.resolve([field]); },
      executeScript: function(script){
        scripts.push(script);
        if (script.indexOf('closest("#book_leave_modal")') !== -1) {
          return Promise.resolve(inBookingModal === true);
        }
        if (result instanceof Error) {
          return Promise.reject(result);
        }
        return Promise.resolve(result);
      },
    },
    scripts: scripts,
  };
}

describe('submit form datepicker fields', function(){
  it('sets datepicker values atomically without keyboard fallback', function(){
    var fixture = fieldDriver(
      visibleField('datepicker'),
      {value: '2026-05-10', valid: true},
      true
    );

    return submitForm._fillFormField(fixture.driver, {
      selector: 'input[name="to_date"]',
      value: '2026-05-10',
    }).then(function(){
      expect(fixture.scripts).to.have.length(2);
      expect(fixture.scripts[0]).to.contain('closest("#book_leave_modal")');
      expect(fixture.scripts[1]).to.contain('datepicker("setDate", arguments[1])');
      expect(fixture.scripts[1]).to.contain('return {value: arguments[0].value, valid:');
    });
  });

  it('fails closed when the datepicker cannot retain an exact valid value', function(){
    var cases = [
      {result: new Error('Datepicker field is missing its datepicker API'), message: 'datepicker API'},
      {result: {value: '2026-05-11', valid: true}, message: 'did not retain'},
      {result: {value: '2026-05-10', valid: false}, message: 'invalid'},
    ];

    return Promise.all(cases.map(function(testCase){
      var fixture = fieldDriver(visibleField('datepicker'), testCase.result, true);
      return submitForm._fillFormField(fixture.driver, {
        selector: 'input[name="to_date"]',
        value: '2026-05-10',
      }).then(function(){
        throw new Error('expected datepicker field to reject');
      }).catch(function(error){
        expect(error.message).to.contain(testCase.message);
        expect(error.message).not.to.contain('to_date');
        expect(error.message).not.to.contain('2026-05-10');
        expect(fixture.scripts).to.have.length(2);
      });
    }));
  });

  it('keeps non-booking datepickers on their existing keyboard path', function(){
    var field = visibleField('datepicker'), calls = [];
    field.clear = function(){ calls.push('clear'); return Promise.resolve(); };
    field.sendKeys = function(value){ calls.push(value); return Promise.resolve(); };
    var fixture = fieldDriver(field, null, false);

    return submitForm._fillFormField(fixture.driver, {
      selector: 'input[name="date__0"]',
      value: 'crap',
    }).then(function(){
      expect(fixture.scripts).to.have.length(1);
      expect(fixture.scripts[0]).to.contain('closest("#book_leave_modal")');
      expect(calls).to.deep.equal(['clear', 'crap', '\uE004']);
    });
  });

  it('keeps non-datepicker fields on their existing keyboard path', function(){
    var field = visibleField(null), calls = [];
    field.clear = function(){ calls.push('clear'); return Promise.resolve(); };
    field.sendKeys = function(value){ calls.push(value); return Promise.resolve(); };
    var fixture = fieldDriver(field, null, false);

    return submitForm._fillFormField(fixture.driver, {
      selector: 'input[name="comment"]',
      value: 'Keep existing behavior',
    }).then(function(){
      expect(fixture.scripts).to.have.length(0);
      expect(calls).to.deep.equal(['clear', 'Keep existing behavior', '\uE004']);
    });
  });
});
