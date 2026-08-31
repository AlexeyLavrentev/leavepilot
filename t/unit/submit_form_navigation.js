'use strict';

var expect = require('chai').expect,
    submitForm = require('../../t/lib/submit_form');

function staleRoot() {
  return {
    getTagName: function(){
      var error = new Error('stale element reference');
      error.name = 'StaleElementReferenceError';
      return Promise.reject(error);
    },
  };
}

function readableRoot() {
  return {
    getTagName: function(){ return Promise.resolve('html'); },
  };
}

function navigationDriver(timeOrigin, readyState) {
  return {
    executeScript: function(script){
      if (script.indexOf('performance.timeOrigin') !== -1) {
        return Promise.resolve(timeOrigin);
      }

      if (script.indexOf('document.readyState') !== -1) {
        return Promise.resolve(readyState);
      }

      throw new Error('Unexpected browser script: ' + script);
    },
  };
}

describe('submit form navigation completion', function(){
  it('accepts a stale submitted root only after the replacement document is complete', function(){
    return submitForm._waitForSubmittedDocument(
      navigationDriver(100, true),
      {root: staleRoot(), timeOrigin: 100},
      20
    );
  });

  it('accepts a same-URL reload when its submitted root remains readable but time origin changes', function(){
    return submitForm._waitForSubmittedDocument(
      navigationDriver(200, true),
      {root: readableRoot(), timeOrigin: 100},
      20
    );
  });

  it('fails closed with both navigation signals when neither transition occurs', function(){
    return submitForm._waitForSubmittedDocument(
      navigationDriver(100, true),
      {root: readableRoot(), timeOrigin: 100},
      20
    ).then(function(){
      throw new Error('expected navigation wait to reject');
    }).catch(function(error){
      expect(error.message).to.contain('stale-root');
      expect(error.message).to.contain('time-origin');
      expect(error.message).to.contain('100');
    });
  });

  it('keeps explicit navigation opt-out free of document identity reads', function(){
    var identityReads = 0;
    var htmlReads = 0;
    var button = {isDisplayed: function(){ return Promise.resolve(true); }};
    var driver = {
      executeScript: function(script){
        if (script.indexOf('performance.timeOrigin') !== -1) {
          identityReads += 1;
        }
        if (script.indexOf('Array.prototype.map.call(document.querySelectorAll("div.alert")') !== -1) {
          return Promise.resolve(['Rejected']);
        }
        return Promise.resolve(null);
      },
      findElement: function(){
        htmlReads += 1;
        return Promise.resolve(readableRoot());
      },
      findElements: function(){ return Promise.resolve([button]); },
    };

    return submitForm({
      driver: driver,
      expect_navigation: false,
      message: /Rejected/,
    }).then(function(){
      expect(htmlReads).to.equal(0);
      expect(identityReads).to.equal(0);
    });
  });
});
