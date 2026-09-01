'use strict';

var fs         = require('fs'),
    path       = require('path'),
    url        = require('url'),
    webdriver  = require('selenium-webdriver'),
By             = require('selenium-webdriver').By,
Key            = require('selenium-webdriver').Key,
  expect         = require('chai').expect,
  _              = require('underscore');
var DEFAULT_WAIT_TIMEOUT = 10000;
var MAX_SUBMIT_DIAGNOSTIC_BYTES = 4096;
var MAX_BEFORE_CLICK_HISTORY = 4;

function submit_diagnostic_error(error) {
  var diagnosticError = new Error('Submit diagnostic failure: ' + (error && error.message || error));
  diagnosticError.name = 'SubmitDiagnosticError';
  return diagnosticError;
}

function submit_diagnostic_config() {
  var pathValue = process.env.TEST_SUBMIT_DIAGNOSTIC_PATH;
  var identity = {
    runId: process.env.TEST_SUBMIT_DIAGNOSTIC_RUN_ID,
    batchId: process.env.TEST_SUBMIT_DIAGNOSTIC_BATCH_ID,
    spec: process.env.TEST_SUBMIT_DIAGNOSTIC_SPEC,
  };
  if (!pathValue && !identity.runId && !identity.batchId && !identity.spec) {
    return null;
  }
  if (!pathValue || !identity.runId || !identity.batchId || !identity.spec) {
    throw submit_diagnostic_error('incomplete runner identity');
  }
  return {path: pathValue, identity: identity};
}

function safe_submit_url(value) {
  var parsed = url.parse(String(value || ''));
  if (!parsed.protocol || !parsed.host) {
    return 'unreadable';
  }
  return parsed.protocol + '//' + parsed.host + (parsed.pathname || '/');
}

function safe_class_tokens(tokens) {
  if (!Array.isArray(tokens)) {
    return [];
  }
  return tokens.filter(function(token){
    return typeof token === 'string'
      && /^[a-zA-Z0-9_-]{1,48}$/.test(token)
      && !/(authorization|cookie|password|secret|token|api[_-]?key|key)/i.test(token);
  }).slice(0, 12);
}

function safe_form_action(value) {
  var parsed = url.parse(String(value || ''));
  var pathname = parsed.pathname;
  if (typeof pathname !== 'string' || !/^\/[A-Za-z0-9._~!$&'()*+,;=:@/%-]{0,511}$/.test(pathname)) {
    return 'unreadable';
  }
  return pathname;
}

function safe_submit_tag(value) {
  var tag = typeof value === 'string' ? value.toLowerCase() : '';
  return ['button', 'input'].indexOf(tag) !== -1 ? tag : 'unreadable';
}

function safe_submit_type(value) {
  var type = typeof value === 'string' ? value.toLowerCase() : '';
  return /^[a-z][a-z0-9_-]{0,31}$/.test(type) ? type : 'unreadable';
}

function safe_form_ownership(value) {
  return ['ancestor', 'external', 'none'].indexOf(value) !== -1 ? value : 'unreadable';
}

function safe_invalid_control_tag(value) {
  var tag = typeof value === 'string' ? value.toLowerCase() : '';
  return ['input', 'select', 'textarea'].indexOf(tag) !== -1 ? tag : 'unreadable';
}

function safe_invalid_control_name(value) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(value)
    || /(authorization|cookie|password|secret|token|api[_-]?key|key)/i.test(value)) {
    return 'unreadable';
  }
  return value;
}

function safe_invalid_control(value) {
  if (!value || typeof value !== 'object') {
    return {tag: 'unreadable', type: 'unreadable', name: 'unreadable'};
  }
  return {
    tag: safe_invalid_control_tag(value.tag),
    type: safe_submit_type(value.type),
    name: safe_invalid_control_name(value.name),
  };
}

function safe_submit_state(raw, details) {
  raw = raw || {};
  var modal = raw.modal || {};
  var submit = raw.submit || {};
  var events = raw.events || {};
  return {
    stage: details.stage,
    url: safe_submit_url(raw.url),
    timeOrigin: Number.isFinite(raw.timeOrigin) ? raw.timeOrigin : null,
    readyState: ['loading', 'interactive', 'complete'].indexOf(raw.readyState) !== -1
      ? raw.readyState : 'unreadable',
    rootStatus: ['absent', 'unreadable', 'alive', 'stale', 'unobserved'].indexOf(details.rootStatus) !== -1
      ? details.rootStatus : 'unreadable',
    modal: {
      presence: typeof modal.presence === 'boolean' ? modal.presence : 'unreadable',
      visible: typeof modal.visible === 'boolean' ? modal.visible : 'unreadable',
      classTokens: safe_class_tokens(modal.classTokens),
    },
    submit: {
      presence: typeof submit.presence === 'boolean' ? submit.presence : 'unreadable',
      disabled: typeof submit.disabled === 'boolean' ? submit.disabled : 'unreadable',
      connected: typeof submit.connected === 'boolean' ? submit.connected : 'unreadable',
      formAction: safe_form_action(submit.formAction),
      inModal: typeof submit.inModal === 'boolean' ? submit.inModal : 'unreadable',
      tag: safe_submit_tag(submit.tag),
      type: safe_submit_type(submit.type),
      formPresent: typeof submit.formPresent === 'boolean' ? submit.formPresent : 'unreadable',
      formOwnership: safe_form_ownership(submit.formOwnership),
      formValid: typeof submit.formValid === 'boolean' ? submit.formValid : 'unreadable',
      invalidControl: submit.formValid === false
        ? safe_invalid_control(submit.invalidControl)
        : null,
    },
    events: {
      submit: Number.isSafeInteger(events.submit) && events.submit >= 0 ? events.submit : 0,
      beforeunload: Number.isSafeInteger(events.beforeunload) && events.beforeunload >= 0 ? events.beforeunload : 0,
    },
  };
}

function previous_before_click_history(config) {
  var text;
  try {
    text = fs.readFileSync(config.path, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  if (Buffer.byteLength(text) > MAX_SUBMIT_DIAGNOSTIC_BYTES) {
    throw new Error('existing submit diagnostic exceeds size limit');
  }

  var payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error('existing submit diagnostic is malformed');
  }

  if (!payload || payload.version !== 1 || !payload.identity || !payload.state
    || payload.identity.runId !== config.identity.runId
    || payload.identity.batchId !== config.identity.batchId
    || payload.identity.spec !== config.identity.spec) {
    throw new Error('existing submit diagnostic identity mismatch');
  }

  if (payload.state.beforeClickHistory === undefined) {
    return [];
  }
  if (!Array.isArray(payload.state.beforeClickHistory)
    || payload.state.beforeClickHistory.length > MAX_BEFORE_CLICK_HISTORY) {
    throw new Error('existing submit diagnostic history is malformed');
  }
  return payload.state.beforeClickHistory;
}

function write_submit_diagnostic(config, state) {
  var before_click_history = previous_before_click_history(config);
  if (state.stage === 'before-click' && before_click_history.length < MAX_BEFORE_CLICK_HISTORY) {
    before_click_history = before_click_history.concat([JSON.parse(JSON.stringify(state))]);
  }
  state.beforeClickHistory = before_click_history;
  var payload = {version: 1, identity: config.identity, state: state};
  var serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized) > MAX_SUBMIT_DIAGNOSTIC_BYTES) {
    throw new Error('submit diagnostic snapshot exceeds size limit');
  }
  var temporary = config.path + '.' + process.pid + '.tmp';
  fs.mkdirSync(path.dirname(config.path), {recursive: true});
  fs.writeFileSync(temporary, serialized + '\n', {mode: 0o600});
  fs.renameSync(temporary, config.path);
}

function capture_submit_diagnostic(driver, details) {
  var config;
  try {
    config = submit_diagnostic_config();
  } catch (error) {
    return Promise.reject(error);
  }
  if (!config) {
    return Promise.resolve(null);
  }

  return withDeadline('installing submit diagnostic observers', driver.executeScript(
    'var state = window.__leavePilotSubmitDiagnostic || {submit: 0, beforeunload: 0};'
    + 'if (!state.installed) {'
    + ' window.addEventListener("submit", function(){ state.submit += 1; }, true);'
    + ' window.addEventListener("beforeunload", function(){ state.beforeunload += 1; }, true);'
    + ' state.installed = true;'
    + '}'
    + 'window.__leavePilotSubmitDiagnostic = state;'
  )).then(function(){
    return withDeadline('capturing submit diagnostic state', driver.executeScript(
      'var state = window.__leavePilotSubmitDiagnostic || {submit: 0, beforeunload: 0};'
      + 'var modal = arguments[0] ? document.querySelector(arguments[0]) : null;'
      + 'var submit = arguments[1] ? document.querySelector(arguments[1]) : null;'
      + 'return {'
      + ' url: location.href, timeOrigin: performance.timeOrigin, readyState: document.readyState,'
      + ' modal: {presence: !!modal, visible: !!(modal && (modal.offsetWidth || modal.offsetHeight || modal.getClientRects().length)), classTokens: modal ? String(modal.className || "").split(/\\s+/) : []},'
      + ' submit: {'
      + 'presence: !!submit, disabled: !!(submit && submit.disabled), connected: !!(submit && submit.isConnected),'
      + 'formAction: submit && submit.form ? submit.form.action : null,'
      + 'inModal: !!(modal && submit && modal.contains(submit)), tag: submit && submit.tagName, type: submit && submit.type'
      + ', formPresent: !!(submit && submit.form),'
      + 'formOwnership: !(submit && submit.form) ? "none" : (submit.form.contains(submit) ? "ancestor" : "external"),'
      + 'formValid: submit && submit.form ? submit.form.checkValidity() : null,'
      + 'invalidControl: (function(){'
      + 'var form = submit && submit.form; var invalid = form && form.checkValidity() === false ? form.querySelector("input:invalid, select:invalid, textarea:invalid") : null;'
      + 'return invalid ? {tag: invalid.tagName, type: invalid.type, name: invalid.name} : null;'
      + '})()'
      + '},'
      + ' events: {submit: state.submit, beforeunload: state.beforeunload}'
      + '};',
      details.modalSelector || null,
      details.submitSelector || null
    ));
  }).then(function(raw){
    write_submit_diagnostic(config, safe_submit_state(raw, details));
    return null;
  }).catch(function(error){
    if (error && error.name === 'SubmitDiagnosticError') {
      throw error;
    }
    throw submit_diagnostic_error(error);
  });
}

/*
  driver.wait() polls a condition and gives up after its timeout — but only
  between polls. While a poll is still in flight it cannot time out at all, so a
  WebDriver command that never returns hangs the whole chain: the five-second
  wait below never fires, the test burns its entire budget, and because the
  promise stays pending rather than rejecting there is nothing for a
  .catch(done) to catch. That is exactly what the runner kept reporting as a
  bare "Timeout of 120000ms exceeded" with no cause, and the form trace pinned
  it to a DOM read issued while a submit was still navigating the page.

  Racing each command against a deadline turns that into a rejection that names
  the step. The command itself cannot be cancelled, so its result is ignored
  once the deadline wins.
*/
var COMMAND_DEADLINE_MS = Number(process.env.TEST_COMMAND_DEADLINE_MS) > 0
  ? Number(process.env.TEST_COMMAND_DEADLINE_MS)
  : 15000;

function withDeadline(what, command) {
  var settled = false;
  var timer;

  trace('command:issued', what);

  var guarded = Promise.resolve(command).then(
    function(value){ settled = true; clearTimeout(timer); trace('command:returned', what); return value; },
    function(error){ settled = true; clearTimeout(timer); trace('command:failed', what); throw error; }
  );

  var deadline = new Promise(function(resolve, reject){
    timer = setTimeout(function(){
      if (settled) { return; }
      trace('command:deadline', what);
      var error = new Error(
        'WebDriver command did not return within ' + COMMAND_DEADLINE_MS + 'ms: ' + what
        + '. A driver.wait() cannot expire while its poll is still in flight, so this '
        + 'would otherwise hang until the spec budget ran out with nothing to catch.'
      );
      error.commandDeadlineExceeded = true;
      reject(error);
    }, COMMAND_DEADLINE_MS);
  });

  // Whichever loses is left to settle on its own; swallow it so bluebird does
  // not report an unhandled rejection for the abandoned side.
  guarded.catch(function(){});

  return Promise.race([guarded, deadline]);
}

/*
  driver.wait() proved unable to settle on the runner: the trace shows its
  condition polling happily, each command returning in single-digit
  milliseconds, and then the loop simply stopping — never resolving, never
  rejecting, never honouring its own timeout. A spec then burns its whole budget
  and reports a timeout with no cause.

  Polling here instead removes that dependency. The loop is bounded by a
  deadline we own, so it always settles one way or the other.
*/
function poll_until(what, condition, timeout) {
  var deadline = Date.now() + timeout;

  function attempt() {
    return Promise.resolve()
      .then(condition)
      .then(function(result){
        if (result) {
          return result;
        }

        if (Date.now() >= deadline) {
          var error = new Error('Timed out after ' + timeout + 'ms waiting for ' + what);
          error.pollTimedOut = true;
          throw error;
        }

        return new Promise(function(r){setTimeout(r,50)}).then(attempt);
      });
  }

  return attempt();
}

/*
  The polling conditions below treat any failure as "not ready yet" and try
  again, which is right for an element that has not rendered but wrong for a
  wedged command: swallowing the deadline puts the chain straight back into the
  same hang, through an unguarded fallback. A wedge has to propagate.
*/
function is_command_deadline_error(err) {
  return !!(err && err.commandDeadlineExceeded);
}

function rethrow_wedge(fallback) {
  return function(err) {
    if (is_command_deadline_error(err)) {
      throw err;
    }

    return typeof fallback === 'function' ? fallback(err) : fallback;
  };
}

/*
  Opt-in step tracing. A form submit that wedges shows up as a bare mocha
  timeout with no indication of which command never came back, and the hang has
  not reproduced outside CI. With TEST_TRACE_FORMS=1 the last line printed names
  the step that stuck.
*/
var TRACE = process.env.TEST_TRACE_FORMS === '1';

function trace(step, detail) {
  if (!TRACE) { return; }
  process.stderr.write(
    '[form] ' + new Date().toISOString() + ' ' + step
    + (detail === undefined ? '' : ' ' + detail) + '\n'
  );
}

function traced(step, detail, promise) {
  if (!TRACE) { return promise; }
  trace(step + ':start', detail);
  return promise.then(
    function(value){ trace(step + ':done', detail); return value; },
    function(err){ trace(step + ':failed', detail + ' ' + (err && err.name)); throw err; }
  );
}

/*
  This is diagnostics only. A redirect back to the same URL has no observable
  location change, so record browser-owned document identity signals around a
  submitted form when explicitly requested by a recovery run.
*/
function trace_document_state(driver, stage) {
  if (!TRACE) { return Promise.resolve(null); }

  return withDeadline('reading document state ' + stage, driver.executeScript(
    'var entries = performance.getEntriesByType("navigation");'
    + 'var latest = entries.length ? entries[entries.length - 1] : null;'
    + 'return {'
    + 'url: location.href,'
    + 'timeOrigin: performance.timeOrigin,'
    + 'readyState: document.readyState,'
    + 'navigationType: latest && latest.type'
    + '};'
  )).then(function(state){
    trace('document:' + stage, JSON.stringify(state));
    return state;
  }).catch(function(error){
    trace('document:' + stage + ':failed', error && error.name);
    throw error;
  });
}

function is_stale_element_error(err) {
  return err && (
    err.name === 'StaleElementReferenceError' ||
    /stale element reference/.test(err.message || '')
  );
}

function find_visible_element(driver, selector) {
  return poll_until('a visible ' + selector, function(){
    return withDeadline('locating ' + selector, driver.findElements(By.css(selector)))
      .then(function(els){
        var findFlow = Promise.resolve(-1);

        els.forEach(function(el){
          findFlow = findFlow.then(function(foundIndex){
            if (foundIndex !== -1) {
              return foundIndex;
            }

            return el.isDisplayed()
              .then(function(visible){
                return visible ? els.indexOf(el) : -1;
              })
              .catch(function(){
                return -1;
              });
          });
        });

        return findFlow.then(function(foundIndex){
          return foundIndex === -1 ? false : foundIndex + 1;
        });
      })
      .catch(rethrow_wedge(false));
  }, DEFAULT_WAIT_TIMEOUT)
    .then(function(foundIndex){
      return withDeadline('re-reading ' + selector, driver.findElements(By.css(selector)))
        .then(function(els){
          return els[foundIndex - 1];
        });
    })
    .catch(rethrow_wedge(function(){
      return withDeadline('falling back to ' + selector, driver.findElement(By.css(selector)));
    }));
}

function is_element_not_interactable_error(err) {
  return err && (
    err.name === 'ElementNotVisibleError' ||
    err.name === 'ElementNotInteractableError' ||
    /element not interactable/.test(err.message || '')
  );
}

function click_element(driver, el) {
  return driver.executeScript(
    'arguments[0].scrollIntoView({block: "center", inline: "nearest"}); arguments[0].click();',
    el
  );
}

function read_document_time_origin(driver, stage) {
  return withDeadline('reading document time origin ' + stage, driver.executeScript(
    'return performance.timeOrigin;'
  ));
}

function wait_for_submitted_document(driver, previous_document, timeout, observe) {
  timeout = timeout || DEFAULT_WAIT_TIMEOUT;
  var last_observation = {
    root_status: 'unobserved',
    original_time_origin: previous_document.timeOrigin,
    current_time_origin: 'unobserved',
  };

  return poll_until('submitted document to replace the current page', function(){
    return Promise.resolve()
      .then(function(){
        return withDeadline('checking submitted document transition', Promise.resolve()
          .then(function(){ return previous_document.root.getTagName(); }));
      })
      .then(function(){ return 'alive'; })
      .catch(function(err){
        if (is_stale_element_error(err)) {
          return 'stale';
        }

        throw err;
      })
      .then(function(root_status){
        last_observation.root_status = root_status;
        return read_document_time_origin(driver, 'after-submit-poll');
      })
      .then(function(current_time_origin){
        last_observation.current_time_origin = current_time_origin;
        if (observe) {
          return Promise.resolve(observe({
            rootStatus: last_observation.root_status,
            stage: 'navigation-observation',
          })).then(function(){ return current_time_origin; });
        }
        return current_time_origin;
      })
      .then(function(current_time_origin){
        var time_origin_changed = Number.isFinite(previous_document.timeOrigin)
          && Number.isFinite(current_time_origin)
          && current_time_origin !== previous_document.timeOrigin;

        if (last_observation.root_status !== 'stale' && !time_origin_changed) {
          trace('submitted-document:alive');
          return false;
        }

        trace('submitted-document:' + (last_observation.root_status === 'stale' ? 'stale' : 'time-origin-changed'));
        return withDeadline('checking submitted document readiness', driver.executeScript(
          'return document.readyState === "complete";'
        ));
      });
  }, timeout).catch(function(err){
    if (!err.pollTimedOut) {
      throw err;
    }

    throw new Error(
      'Timed out waiting for submitted document transition. '
      + 'stale-root=' + last_observation.root_status + '; '
      + 'time-origin original=' + last_observation.original_time_origin
      + ' current=' + last_observation.current_time_origin
    );
  });
}

function describe_modal_state(driver, selector) {
  return withDeadline('inspecting modal ' + selector, driver.findElements(By.css(selector)))
    .then(function(els){
      if (!els.length) {
        return 'absent';
      }

      return Promise.all(els.map(function(el){
        return withDeadline('checking modal visibility ' + selector, el.isDisplayed())
          .then(function(visible){ return visible ? 'visible' : 'not displayed'; })
          .catch(rethrow_wedge('unreadable'));
      })).then(function(states){
        return states.join(', ');
      });
    });
}

function wait_for_modal_closed(driver, selector, timeout) {
  timeout = timeout || DEFAULT_WAIT_TIMEOUT;

  return poll_until('modal ' + selector + ' to close', function(){
    return describe_modal_state(driver, selector)
      .then(function(state){ return state === 'absent' || state === 'not displayed'; })
      .catch(rethrow_wedge(false));
  }, timeout)
    .catch(rethrow_wedge(function(error){
      if (!error.pollTimedOut) {
        throw error;
      }

      return describe_modal_state(driver, selector).then(function(state){
        throw new Error('Timed out waiting for modal ' + selector + ' to close. Current modal state: ' + state);
      });
    }));
}

function set_element_value(driver, el, value, change_step) {
  return driver.executeScript(
    'if (arguments[2]) { arguments[0].step = "0.1"; }'
    + 'arguments[0].focus();'
    + 'arguments[0].value = "";'
    + 'var inputEvent = document.createEvent("HTMLEvents");'
    + 'inputEvent.initEvent("input", true, false);'
    + 'arguments[0].dispatchEvent(inputEvent);'
    + 'arguments[0].value = arguments[1];'
    + 'var changeEvent = document.createEvent("HTMLEvents");'
    + 'changeEvent.initEvent("change", true, false);'
    + 'arguments[0].dispatchEvent(inputEvent);'
    + 'arguments[0].dispatchEvent(changeEvent);'
    + 'arguments[0].blur();',
    el,
    value,
    !!change_step
  );
}

function type_element_value(driver, el, value, change_step) {
  if (typeof el.clear !== 'function' || typeof el.sendKeys !== 'function') {
    return set_element_value(driver, el, value, change_step);
  }

  var flow = Promise.resolve();

  if (change_step) {
    flow = flow.then(function(){
      return driver.executeScript("return arguments[0].step = '0.1'", el);
    });
  }

  return flow
    .then(function(){
      return traced('clear', String(value), el.clear());
    })
    .then(function(){
      return traced('sendKeys', String(value), el.sendKeys(value));
    })
    .then(function(){
      return traced('tab', String(value), el.sendKeys(Key.TAB));
    });
}

function set_datepicker_value(driver, el, value) {
  return driver.executeScript(
    'var $ = window.jQuery;'
    + 'if (!$ || !$.fn || typeof $.fn.datepicker !== "function") {'
    + ' throw new Error("Datepicker field is missing its datepicker API");'
    + '}'
    + '$(arguments[0]).datepicker("setDate", arguments[1]);'
    + 'return {value: arguments[0].value, valid: typeof arguments[0].checkValidity === "function" && arguments[0].checkValidity()};',
    el,
    value
  ).then(function(result){
    if (!result || result.value !== value) {
      throw new Error('Datepicker did not retain the requested value');
    }
    if (result.valid !== true) {
      throw new Error('Datepicker field is invalid after setting its value');
    }
  });
}

function is_booking_datepicker_field(driver, el) {
  if (typeof el.getAttribute !== 'function') {
    return Promise.resolve(false);
  }

  return el.getAttribute('data-provide')
    .then(function(value){
      if (value !== 'datepicker') {
        return false;
      }

      return driver.executeScript(
        'return !!arguments[0].closest("#book_leave_modal");',
        el
      );
    })
    .then(function(value){ return value === true; });
}

function fill_form_field(driver, test_case, attempt) {
  attempt = attempt || 0;

  if (Object.keys(test_case).length === 0 ){
    return Promise.resolve(1);
  }

  return traced('find', test_case.selector, find_visible_element(driver, test_case.selector))
    .then(function(el){
      if ( Object.prototype.hasOwnProperty.call(test_case, 'option_selector') ) {
        if (Object.prototype.hasOwnProperty.call(test_case, 'value')) {
          return driver.executeScript(
            'arguments[0].value = arguments[1];'
            + 'var event = document.createEvent("HTMLEvents");'
            + 'event.initEvent("change", true, false);'
            + 'arguments[0].dispatchEvent(event);',
            el,
            test_case.value
          );
        }

        return el.findElement(By.css( test_case.option_selector ))
          .then(function(optionEl){
            return optionEl.getAttribute('value');
          })
          .then(function(value){
            return driver.executeScript(
              'arguments[0].value = arguments[1];'
              + 'var event = document.createEvent("HTMLEvents");'
              + 'event.initEvent("change", true, false);'
              + 'arguments[0].dispatchEvent(event);',
              el,
              value
            );
          });
      }

      if ( Object.prototype.hasOwnProperty.call(test_case, 'tick')) {
        return el.isSelected()
          .then(function(selected){
            if (test_case.value === 'on' && selected) {
              return null;
            }

            if (test_case.value === 'off' && !selected) {
              return null;
            }

            return click_element(driver, el);
          });
      }

      if (test_case.file) {
        return el.sendKeys(test_case.value);
      }

      if (Object.prototype.hasOwnProperty.call(test_case, 'dropdown_option')) {
        return click_element(driver, el)
          .then(function(){ return driver.findElement(By.css(test_case.dropdown_option)); })
          .then(function(dd){ return click_element(driver, dd); });
      }

      return is_booking_datepicker_field(driver, el)
        .then(function(isBookingDatepicker){
          if (isBookingDatepicker) {
            return set_datepicker_value(driver, el, test_case.value);
          }

          // Prevent the browser validations to allow backend validations to occur
          return type_element_value(driver, el, test_case.value, test_case.change_step);
        });

    })
    .catch(function(err){
      if ((is_stale_element_error(err) || is_element_not_interactable_error(err)) && attempt < 2) {
        return driver.sleep(100)
          .then(function(){
            return fill_form_field(driver, test_case, attempt + 1);
          });
      }

      throw err;
    });
}

function read_alert_texts(driver) {
  trace('readAlerts', 'poll');
  return withDeadline('reading flash messages', driver.executeScript(
    'return Array.prototype.map.call(document.querySelectorAll("div.alert"), function(el) {'
    + '  return el.textContent;'
    + '});'
  ));
}

function wait_for_matching_alert(driver, message, multi_line_message) {
  trace('waitAlert', String(message));
  return poll_until('flash message ' + message, function(){
    return read_alert_texts(driver)
      .then(function(texts){
        if (!texts.length) {
          return false;
        }

        if (multi_line_message) {
          return _.any(texts, function(text){ return message.test(text); }) ? texts : false;
        }

        return _.find(texts, function(text){ return message.test(text); }) || false;
      })
      .catch(rethrow_wedge(false));
  }, DEFAULT_WAIT_TIMEOUT);
}

function wait_for_expected_elements(driver, elements_to_check) {
  if (!elements_to_check.length) {
    return Promise.resolve(true);
  }

  return poll_until('form fields to hold their submitted values', function(){
    return Promise.all(_.map(elements_to_check, function(test_case){
      return withDeadline('reading ' + test_case.selector, driver.findElement(By.css(test_case.selector)))
        .then(function(el){
          if (Object.prototype.hasOwnProperty.call(test_case, 'tick')) {
            return el.isSelected().then(function(yes){
              return yes ? 'on' : 'off';
            });
          }

          return el.getAttribute('value');
        })
        .then(function(value){
          return value === test_case.value;
        });
    }))
    .then(function(checks){
      return _.every(checks, function(check){ return check; });
    })
    .catch(rethrow_wedge(false));
  }, DEFAULT_WAIT_TIMEOUT);
}

function clear_existing_alerts(driver) {
  return driver.executeScript(
    'var alerts = document.querySelectorAll("div.alert");'
    + 'Array.prototype.forEach.call(alerts, function(alert) {'
    + '  alert.parentNode.removeChild(alert);'
    + '});'
  );
}

function submit_form_func(args) {
  var driver          = args.driver,
      // Regex to check the message that is shown after form is submitted
      message         = args.message || /.*/,
      // Array of object that have at least two keys: selector - css selector
      // and value - value to be entered
      form_params     = args.form_params || [],

      // Defined how elemts are going to be checked in case of success,
      // if that parameter is omitted - 'form_params' is used instead
      elements_to_check   = args.elements_to_check || form_params,

      // Indicates whether form submission is going to be successful
      should_be_successful = args.should_be_successful || false,

      // Indicate if message to be searched through all messages shown,
      // bu defaul it looks into firts message only
      multi_line_message = args.multi_line_message || false,

      // Indicates if there is a confirmation dialog
      confirm_dialog = args.confirm_dialog || false,

      // CSS selecetor for form submition button
      submit_button_selector = args.submit_button_selector ||'button[type="submit"]',
      modal_selector = args.modal_selector,
      expect_navigation = args.expect_navigation !== false;

    return Promise.resolve()
      .then(function(){
        return form_params.reduce(function(p, test_case){
          return p.then(function(){ return fill_form_field(driver, test_case); });
        }, Promise.resolve());
      })
      .then(function(){
        if (confirm_dialog) {
          return driver.executeScript('window.confirm = function(msg) { return true; }');
        }
      })
      .then(function(){
        return clear_existing_alerts(driver);
      })
      .then(function(){
        if (!expect_navigation) {
          return null;
        }

        return withDeadline('capturing submitted document', driver.findElement(By.css('html')))
          .then(function(root){
            return read_document_time_origin(driver, 'before-submit')
              .then(function(timeOrigin){
                return {root: root, timeOrigin: timeOrigin};
              });
          });
      })
      .then(function(previous_document){
        var before_submit = expect_navigation
          ? trace_document_state(driver, 'before-submit')
          : Promise.resolve(null);

        return before_submit.then(function(){
          return capture_submit_diagnostic(driver, {
            stage: 'before-click', modalSelector: modal_selector,
            submitSelector: submit_button_selector, rootStatus: 'alive',
          });
        }).then(function(){
          return traced('findSubmit', submit_button_selector,
            find_visible_element(driver, submit_button_selector));
        })
          .then(function(el){
            return traced('clickSubmit', submit_button_selector, click_element(driver, el));
          })
          .then(function(){
            return capture_submit_diagnostic(driver, {
              stage: 'after-click', modalSelector: modal_selector,
              submitSelector: submit_button_selector, rootStatus: 'unobserved',
            });
          })
          .then(function(){
            if (!expect_navigation) {
              return null;
            }

            return wait_for_submitted_document(driver, previous_document, null, function(observation){
              observation.modalSelector = modal_selector;
              observation.submitSelector = submit_button_selector;
              return capture_submit_diagnostic(driver, observation);
            });
          })
          .then(function(){
            if (!modal_selector) {
              return null;
            }

            return wait_for_modal_closed(driver, modal_selector).then(function(){
              return capture_submit_diagnostic(driver, {
                stage: 'modal-observation', modalSelector: modal_selector,
                submitSelector: submit_button_selector, rootStatus: 'unobserved',
              });
            });
          })
          .catch(function(error){
            return capture_submit_diagnostic(driver, {
              stage: 'helper-rejection', modalSelector: modal_selector,
              submitSelector: submit_button_selector, rootStatus: 'unreadable',
            }).then(function(){
              throw error;
            });
          });
      })
      .then(function(){
        if (!should_be_successful) {
          return wait_for_matching_alert(driver, message, multi_line_message)
            .catch(rethrow_wedge(function(){
              return read_alert_texts(driver)
                .then(function(alertTexts){
                  throw new Error(
                    'Timed out waiting for flash message after failed submit. '
                    + 'Expected: ' + message + '. '
                    + 'Current alerts: ' + JSON.stringify(alertTexts)
                  );
                });
            }));
        }

        return wait_for_expected_elements(driver, elements_to_check)
          .then(function(){
            if (String(message) === '/.*/') {
              return null;
            }

            return wait_for_matching_alert(driver, message, multi_line_message)
              .catch(rethrow_wedge(function(){
                return read_alert_texts(driver)
                  .then(function(alertTexts){
                    throw new Error(
                      'Timed out waiting for flash message after successful submit. '
                      + 'Expected: ' + message + '. '
                      + 'Current alerts: ' + JSON.stringify(alertTexts)
                    );
                  });
              }));
          });
      })
      .then(function(alertResult){
        if (alertResult && !multi_line_message && typeof alertResult === 'string') {
          expect(alertResult).to.match(message);
        }

        if (alertResult && multi_line_message) {
          expect(
            _.any(alertResult, function(text){ return message.test(text); })
          ).to.be.equal(true);
        }

        return {
          driver : driver,
        };
      });
}

module.exports = submit_form_func;
module.exports._waitForModalClosed = wait_for_modal_closed;
module.exports._shouldWaitForModal = function(args) {
  return !!args.modal_selector;
};
module.exports._traceDocumentState = trace_document_state;
module.exports._waitForSubmittedDocument = wait_for_submitted_document;
module.exports._captureSubmitDiagnostic = capture_submit_diagnostic;
module.exports._safeSubmitState = safe_submit_state;
module.exports._fillFormField = fill_form_field;
