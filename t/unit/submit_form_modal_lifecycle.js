'use strict';

var expect = require('chai').expect,
    submitForm = require('../../t/lib/submit_form');

function visibleModalDriver() {
  var modalQueries = 0;
  var modal = {
    isDisplayed: function(){ return Promise.resolve(true); },
  };

  return {
    driver: {
      findElements: function(){
        modalQueries += 1;
        return Promise.resolve([modal]);
      },
    },
    modalQueries: function(){ return modalQueries; },
  };
}

describe('submit form modal lifecycle', function(){
  it('waits for an opt-in modal selector to close and reports visible state', function(){
    var fixture = visibleModalDriver();

    return submitForm._waitForModalClosed(fixture.driver, '#book_leave_modal', 20)
      .then(function(){
        throw new Error('expected modal close wait to fail');
      })
      .catch(function(error){
        expect(error.message).to.contain('#book_leave_modal');
        expect(error.message).to.contain('visible');
        expect(fixture.modalQueries()).to.be.greaterThan(0);
      });
  });

  it('does not inspect a modal when callers omit the opt-in selector', function(){
    expect(submitForm._shouldWaitForModal({})).to.equal(false);
    expect(submitForm._shouldWaitForModal({modal_selector: '#book_leave_modal'})).to.equal(true);
  });
});
