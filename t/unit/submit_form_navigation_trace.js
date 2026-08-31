'use strict';

var expect = require('chai').expect;

describe('submit form navigation trace', function(){
  var originalTraceForms;
  var originalWrite;
  var submitForm;
  var lines;

  beforeEach(function(){
    originalTraceForms = process.env.TEST_TRACE_FORMS;
    process.env.TEST_TRACE_FORMS = '1';
    delete require.cache[require.resolve('../../t/lib/submit_form')];
    submitForm = require('../../t/lib/submit_form');
    lines = [];
    originalWrite = process.stderr.write;
    process.stderr.write = function(line){ lines.push(String(line)); return true; };
  });

  afterEach(function(){
    process.stderr.write = originalWrite;
    if (originalTraceForms === undefined) {
      delete process.env.TEST_TRACE_FORMS;
    } else {
      process.env.TEST_TRACE_FORMS = originalTraceForms;
    }
    delete require.cache[require.resolve('../../t/lib/submit_form')];
  });

  it('records safe same-URL navigation identity signals only when tracing is enabled', function(){
    var driver = {
      executeScript: function(){
        return Promise.resolve({
          url: 'http://127.0.0.1:3000/calendar',
          timeOrigin: 123,
          readyState: 'complete',
          navigationType: 'navigate',
        });
      },
    };

    return submitForm._traceDocumentState(driver, 'before-submit').then(function(state){
      expect(state).to.deep.equal({
        url: 'http://127.0.0.1:3000/calendar',
        timeOrigin: 123,
        readyState: 'complete',
        navigationType: 'navigate',
      });
      expect(lines.join('')).to.contain('document:before-submit');
      expect(lines.join('')).to.contain('"timeOrigin":123');
    });
  });
});
