'use strict';

var fs = require('fs'),
    os = require('os'),
    path = require('path'),
    expect = require('chai').expect;

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

  it('does not touch the browser when runner submit diagnostics are absent', function(){
    delete process.env.TEST_SUBMIT_DIAGNOSTIC_PATH;
    delete process.env.TEST_SUBMIT_DIAGNOSTIC_RUN_ID;
    delete process.env.TEST_SUBMIT_DIAGNOSTIC_BATCH_ID;
    delete process.env.TEST_SUBMIT_DIAGNOSTIC_SPEC;
    delete require.cache[require.resolve('../../t/lib/submit_form')];
    submitForm = require('../../t/lib/submit_form');
    var calls = 0;

    return submitForm._captureSubmitDiagnostic({
      executeScript: function(){ calls += 1; return Promise.resolve(null); },
    }, {stage: 'before-click', rootStatus: 'alive'}).then(function(){
      expect(calls).to.equal(0);
    });
  });

  it('writes a bounded redacted submit snapshot only with runner identity', function(){
    var directory = fs.mkdtempSync(path.join(os.tmpdir(), 'submit-diagnostic-'));
    var snapshotPath = path.join(directory, 'submit.json');
    process.env.TEST_SUBMIT_DIAGNOSTIC_PATH = snapshotPath;
    process.env.TEST_SUBMIT_DIAGNOSTIC_RUN_ID = 'run-1';
    process.env.TEST_SUBMIT_DIAGNOSTIC_BATCH_ID = 'batch-1';
    process.env.TEST_SUBMIT_DIAGNOSTIC_SPEC = 't/integration/safe.js';
    delete require.cache[require.resolve('../../t/lib/submit_form')];
    submitForm = require('../../t/lib/submit_form');

    var driver = {
      executeScript: function(script){
        if (script.indexOf('__leavePilotSubmitDiagnostic') !== -1) {
          return Promise.resolve({
            url: 'http://127.0.0.1:3000/calendar?token=private#secret',
            timeOrigin: 123,
            readyState: 'complete',
            modal: {presence: true, visible: true, classTokens: ['modal', 'token-private']},
            submit: {
              presence: true,
              disabled: false,
              connected: true,
              formAction: 'http://127.0.0.1:3000/calendar/bookleave/?token=private#secret',
              inModal: true,
              tag: 'BUTTON',
              type: 'submit',
              text: 'private form value',
              value: 'private-fixture-token',
            },
            events: {submit: 1, beforeunload: 0},
            text: 'private form value',
          });
        }
        return Promise.resolve(null);
      },
    };

    return submitForm._captureSubmitDiagnostic(driver, {
      stage: 'before-click',
      modalSelector: '#book_leave_modal',
      submitSelector: 'button[type="submit"]',
      rootStatus: 'alive',
    }).then(function(){
      var snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      expect(snapshot.identity).to.deep.equal({
        runId: 'run-1', batchId: 'batch-1', spec: 't/integration/safe.js',
      });
      expect(snapshot.state.url).to.equal('http://127.0.0.1:3000/calendar');
      expect(snapshot.state.submit).to.deep.equal({
        presence: true,
        disabled: false,
        connected: true,
        formAction: '/calendar/bookleave/',
        inModal: true,
        tag: 'button',
        type: 'submit',
        formPresent: 'unreadable',
        formOwnership: 'unreadable',
        formValid: 'unreadable',
        invalidControl: null,
      });
      expect(snapshot.state).to.not.have.property('text');
      expect(JSON.stringify(snapshot)).to.not.contain('private');
      expect(Buffer.byteLength(JSON.stringify(snapshot))).to.be.lessThan(4097);
    }).finally(function(){
      fs.rmSync(directory, {recursive: true, force: true});
      delete process.env.TEST_SUBMIT_DIAGNOSTIC_PATH;
      delete process.env.TEST_SUBMIT_DIAGNOSTIC_RUN_ID;
      delete process.env.TEST_SUBMIT_DIAGNOSTIC_BATCH_ID;
      delete process.env.TEST_SUBMIT_DIAGNOSTIC_SPEC;
    });
  });

  it('bounds malformed matched-control metadata without browser diagnostic failures', function(){
    var directory = fs.mkdtempSync(path.join(os.tmpdir(), 'submit-diagnostic-'));
    var snapshotPath = path.join(directory, 'submit.json');
    process.env.TEST_SUBMIT_DIAGNOSTIC_PATH = snapshotPath;
    process.env.TEST_SUBMIT_DIAGNOSTIC_RUN_ID = 'run-2';
    process.env.TEST_SUBMIT_DIAGNOSTIC_BATCH_ID = 'batch-2';
    process.env.TEST_SUBMIT_DIAGNOSTIC_SPEC = 't/integration/safe.js';
    delete require.cache[require.resolve('../../t/lib/submit_form')];
    submitForm = require('../../t/lib/submit_form');

    var driver = {
      executeScript: function(script){
        if (script.indexOf('__leavePilotSubmitDiagnostic') !== -1) {
          return Promise.resolve({
            submit: {
              presence: true,
              disabled: false,
              connected: true,
              formAction: 'not a path',
              inModal: 'yes',
              tag: '<img>',
              type: 'submit private-fixture-token',
            },
          });
        }
        return Promise.resolve(null);
      },
    };

    return submitForm._captureSubmitDiagnostic(driver, {
      stage: 'before-click', rootStatus: 'alive',
    }).then(function(){
      var snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      expect(snapshot.state.submit).to.deep.equal({
        presence: true,
        disabled: false,
        connected: true,
        formAction: 'unreadable',
        inModal: 'unreadable',
        tag: 'unreadable',
        type: 'unreadable',
        formPresent: 'unreadable',
        formOwnership: 'unreadable',
        formValid: 'unreadable',
        invalidControl: null,
      });
      expect(JSON.stringify(snapshot)).to.not.contain('private');
    }).finally(function(){
      fs.rmSync(directory, {recursive: true, force: true});
      delete process.env.TEST_SUBMIT_DIAGNOSTIC_PATH;
      delete process.env.TEST_SUBMIT_DIAGNOSTIC_RUN_ID;
      delete process.env.TEST_SUBMIT_DIAGNOSTIC_BATCH_ID;
      delete process.env.TEST_SUBMIT_DIAGNOSTIC_SPEC;
    });
  });

  it('captures only safe form validity and ownership facts before clicking', function(){
    var directory = fs.mkdtempSync(path.join(os.tmpdir(), 'submit-diagnostic-'));
    var snapshotPath = path.join(directory, 'submit.json');
    process.env.TEST_SUBMIT_DIAGNOSTIC_PATH = snapshotPath;
    process.env.TEST_SUBMIT_DIAGNOSTIC_RUN_ID = 'run-validity';
    process.env.TEST_SUBMIT_DIAGNOSTIC_BATCH_ID = 'batch-validity';
    process.env.TEST_SUBMIT_DIAGNOSTIC_SPEC = 't/integration/safe.js';
    delete require.cache[require.resolve('../../t/lib/submit_form')];
    submitForm = require('../../t/lib/submit_form');

    var driver = {
      executeScript: function(script){
        if (script.indexOf('formOwnership') !== -1) {
          return Promise.resolve({
            url: 'http://127.0.0.1:3000/calendar?token=private#secret',
            submit: {
              presence: true,
              disabled: false,
              connected: true,
              formAction: 'http://127.0.0.1:3000/calendar/bookleave/?token=private#secret',
              inModal: true,
              tag: 'BUTTON',
              type: 'submit',
              formPresent: true,
              formOwnership: 'external',
              formValid: false,
              invalidControl: {tag: 'INPUT', type: 'text', name: 'password'},
              value: 'private-fixture-value',
            },
          });
        }
        return Promise.resolve(null);
      },
    };

    return submitForm._captureSubmitDiagnostic(driver, {
      stage: 'before-click', rootStatus: 'alive',
    }).then(function(){
      var snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      expect(snapshot.state.submit).to.include({
        formPresent: true,
        formOwnership: 'external',
        formValid: false,
      });
      expect(snapshot.state.submit.invalidControl).to.deep.equal({
        tag: 'input', type: 'text', name: 'unreadable',
      });
      expect(snapshot.state.beforeClickHistory).to.have.lengthOf(1);
      expect(snapshot.state.beforeClickHistory[0]).to.include({
        stage: 'before-click', rootStatus: 'alive',
      });
      expect(snapshot.state.beforeClickHistory[0].submit).to.include({
        formPresent: true, formOwnership: 'external', formValid: false,
      });
      expect(JSON.stringify(snapshot)).to.not.contain('private');
      expect(JSON.stringify(snapshot)).to.not.contain('password');
    }).finally(function(){
      fs.rmSync(directory, {recursive: true, force: true});
      delete process.env.TEST_SUBMIT_DIAGNOSTIC_PATH;
      delete process.env.TEST_SUBMIT_DIAGNOSTIC_RUN_ID;
      delete process.env.TEST_SUBMIT_DIAGNOSTIC_BATCH_ID;
      delete process.env.TEST_SUBMIT_DIAGNOSTIC_SPEC;
    });
  });

  it('selects a direct invalid control instead of an invalid fieldset ancestor', function(){
    var directory = fs.mkdtempSync(path.join(os.tmpdir(), 'submit-diagnostic-'));
    var snapshotPath = path.join(directory, 'submit.json');
    process.env.TEST_SUBMIT_DIAGNOSTIC_PATH = snapshotPath;
    process.env.TEST_SUBMIT_DIAGNOSTIC_RUN_ID = 'run-direct-invalid';
    process.env.TEST_SUBMIT_DIAGNOSTIC_BATCH_ID = 'batch-direct-invalid';
    process.env.TEST_SUBMIT_DIAGNOSTIC_SPEC = 't/integration/safe.js';
    delete require.cache[require.resolve('../../t/lib/submit_form')];
    submitForm = require('../../t/lib/submit_form');

    var invalidCandidates = [
      {tag: 'FIELDSET', type: undefined, name: ''},
      {tag: 'INPUT', type: 'date', name: 'start_date'},
      {tag: 'SELECT', type: 'select-one', name: 'leave_type'},
    ];
    var driver = {
      executeScript: function(script){
        if (script.indexOf('formOwnership') !== -1) {
          expect(script).to.contain('form.querySelector("input:invalid, select:invalid, textarea:invalid")');
          return Promise.resolve({
            submit: {
              presence: true,
              disabled: false,
              connected: true,
              formPresent: true,
              formOwnership: 'ancestor',
              formValid: false,
              invalidControl: invalidCandidates[1],
            },
          });
        }
        return Promise.resolve(null);
      },
    };

    return submitForm._captureSubmitDiagnostic(driver, {
      stage: 'before-click', rootStatus: 'alive',
    }).then(function(){
      var snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      expect(snapshot.state.submit.invalidControl).to.deep.equal({
        tag: 'input', type: 'date', name: 'start_date',
      });
      expect(JSON.stringify(snapshot)).to.not.contain('fieldset');
    }).finally(function(){
      fs.rmSync(directory, {recursive: true, force: true});
      delete process.env.TEST_SUBMIT_DIAGNOSTIC_PATH;
      delete process.env.TEST_SUBMIT_DIAGNOSTIC_RUN_ID;
      delete process.env.TEST_SUBMIT_DIAGNOSTIC_BATCH_ID;
      delete process.env.TEST_SUBMIT_DIAGNOSTIC_SPEC;
    });
  });

  it('preserves bounded before-click evidence across later diagnostic writes', function(){
    var directory = fs.mkdtempSync(path.join(os.tmpdir(), 'submit-diagnostic-'));
    var snapshotPath = path.join(directory, 'submit.json');
    process.env.TEST_SUBMIT_DIAGNOSTIC_PATH = snapshotPath;
    process.env.TEST_SUBMIT_DIAGNOSTIC_RUN_ID = 'run-history';
    process.env.TEST_SUBMIT_DIAGNOSTIC_BATCH_ID = 'batch-history';
    process.env.TEST_SUBMIT_DIAGNOSTIC_SPEC = 't/integration/safe.js';
    delete require.cache[require.resolve('../../t/lib/submit_form')];
    submitForm = require('../../t/lib/submit_form');
    var captures = 0;
    var driver = {
      executeScript: function(script){
        if (script.indexOf('formOwnership') !== -1) {
          captures += 1;
          return Promise.resolve({
            url: 'http://127.0.0.1:3000/calendar',
            submit: {presence: captures === 1, formPresent: captures === 1, formOwnership: 'ancestor', formValid: true},
          });
        }
        return Promise.resolve(null);
      },
    };

    return submitForm._captureSubmitDiagnostic(driver, {
      stage: 'before-click', rootStatus: 'alive',
    }).then(function(){
      return submitForm._captureSubmitDiagnostic(driver, {
        stage: 'helper-rejection', rootStatus: 'unreadable',
      });
    }).then(function(){
      var snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      expect(snapshot.state.stage).to.equal('helper-rejection');
      expect(snapshot.state.beforeClickHistory).to.have.lengthOf(1);
      expect(snapshot.state.beforeClickHistory[0]).to.include({
        stage: 'before-click', rootStatus: 'alive',
      });
      expect(snapshot.state.beforeClickHistory[0].submit).to.include({presence: true, formValid: true});
    }).finally(function(){
      fs.rmSync(directory, {recursive: true, force: true});
      delete process.env.TEST_SUBMIT_DIAGNOSTIC_PATH;
      delete process.env.TEST_SUBMIT_DIAGNOSTIC_RUN_ID;
      delete process.env.TEST_SUBMIT_DIAGNOSTIC_BATCH_ID;
      delete process.env.TEST_SUBMIT_DIAGNOSTIC_SPEC;
    });
  });
});
