'use strict';

var webdriver  = require('selenium-webdriver'),
By             = require('selenium-webdriver').By,
Key            = require('selenium-webdriver').Key,
  expect         = require('chai').expect,
  _              = require('underscore'),
  Promise        = require("bluebird");

var DEFAULT_WAIT_TIMEOUT = 5000;

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

function is_stale_element_error(err) {
  return err && (
    err.name === 'StaleElementReferenceError' ||
    /stale element reference/.test(err.message || '')
  );
}

function find_visible_element(driver, selector) {
  return driver.wait(function(){
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

function fill_form_field(driver, test_case, attempt) {
  attempt = attempt || 0;

  if (Object.keys(test_case).length === 0 ){
    return Promise.resolve(1);
  }

  return traced('find', test_case.selector, find_visible_element(driver, test_case.selector))
    .then(function(el){
      if ( test_case.hasOwnProperty('option_selector') ) {
        if (test_case.hasOwnProperty('value')) {
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
      } else if ( test_case.hasOwnProperty('tick')) {
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
      } else if (test_case.file) {
        return el.sendKeys(test_case.value);
      } else if (test_case.hasOwnProperty('dropdown_option')) {
        return click_element(driver, el)
          .then(function(){ return driver.findElement(By.css(test_case.dropdown_option)); })
          .then(function(dd){ return click_element(driver, dd); });
      } else {
        // Prevent the browser validations to allow backend validations to occur
        return type_element_value(driver, el, test_case.value, test_case.change_step);
      }
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
  return driver.wait(function(){
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

  return driver.wait(function(){
    return Promise.all(_.map(elements_to_check, function(test_case){
      return withDeadline('reading ' + test_case.selector, driver.findElement(By.css(test_case.selector)))
        .then(function(el){
          if (test_case.hasOwnProperty('tick')) {
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
      submit_button_selector = args.submit_button_selector ||'button[type="submit"]';


    return Promise.resolve()
      .then(function(){
        return Promise.each(form_params, function(test_case){
          return fill_form_field(driver, test_case);
        });
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
        return traced('findSubmit', submit_button_selector,
          find_visible_element(driver, submit_button_selector));
      })
      .then(function(el){
        return traced('clickSubmit', submit_button_selector, click_element(driver, el));
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
