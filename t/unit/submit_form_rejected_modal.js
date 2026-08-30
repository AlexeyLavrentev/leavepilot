'use strict';

var expect = require('chai').expect,
    submitForm = require('../../t/lib/submit_form');

function rejectedSubmitDriver() {
  var htmlReads = 0;
  var submitButton = {
    isDisplayed: function(){ return Promise.resolve(true); },
  };
  var previousDocument = {
    getTagName: function(){
      var error = new Error('stale element reference');
      error.name = 'StaleElementReferenceError';
      return Promise.reject(error);
    },
  };

  return {
    driver: {
      executeScript: function(script){
        if (script.indexOf('Array.prototype.map.call(document.querySelectorAll("div.alert")') !== -1) {
          return Promise.resolve(['Failed to create a leave request']);
        }

        if (script.indexOf('document.readyState') !== -1) {
          return Promise.resolve(true);
        }

        return Promise.resolve(null);
      },
      findElement: function(){
        htmlReads += 1;
        return Promise.resolve(previousDocument);
      },
      findElements: function(){
        return Promise.resolve([submitButton]);
      },
    },
    htmlReads: function(){ return htmlReads; },
  };
}

describe('submit form rejected modal completion', function(){
  it('keeps document replacement as the default completion contract', function(){
    var fixture = rejectedSubmitDriver();

    return submitForm({
      driver  : fixture.driver,
      message : /Failed to create a leave request/,
    }).then(function(){
      expect(fixture.htmlReads()).to.equal(1);
    });
  });

  it('allows an explicit rejected submission to complete from its same-document alert', function(){
    var fixture = rejectedSubmitDriver();

    return submitForm({
      driver            : fixture.driver,
      expect_navigation : false,
      message           : /Failed to create a leave request/,
    }).then(function(result){
      expect(result.driver).to.equal(fixture.driver);
      expect(fixture.htmlReads()).to.equal(0);
    });
  });
});
