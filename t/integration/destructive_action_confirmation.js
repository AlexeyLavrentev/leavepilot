'use strict';

/*
  The Delete button on an employee's page asks before it deletes. It stopped.

  The guard was written into the markup:

    <form ... onsubmit="return confirm('Delete this employee?')">

  An inline event handler is script, and script-src 'self' does not allow one,
  so once 'unsafe-inline' came out of the Content-Security-Policy the browser
  quietly declined to install it. Measured in a browser rather than argued
  from the specification:

    {"formFound":true,"attributePresent":true,"handlerInstalled":false}

  The attribute is still in the DOM and reads exactly like a working guard.
  typeof form.onsubmit is "object". Pressing Delete deleted, no dialog.

  Nothing caught it, and the reason is in this directory: every spec that
  removes an employee passes confirm_dialog: true to submit_form, which stubs
  window.confirm to return true before clicking. Those tests pass whether the
  page asks or not.

  So this one goes the other way. It answers no, and expects the employee to
  still be there - which is the only question whose answer depends on the guard
  existing.
*/

const expect = require('chai').expect;
const By = require('selenium-webdriver').By;
const register_new_user_func = require('../lib/register_new_user');
const add_new_user_func = require('../lib/add_new_user');
const open_page_func = require('../lib/open_page');
const submit_form_func = require('../lib/submit_form');
const config = require('../lib/config');

const application_host = config.get_application_host();

describe('Confirmation before an irreversible action', function() {

  this.timeout(config.get_execution_timeout());

  let driver;
  let employeeId;

  /*
    Replaces window.confirm with one that answers as told and records what it
    was asked. Returning false is the whole point: a page that never asks
    cannot be told no.
  */
  const stubConfirm = answer => driver.executeScript(
    'window.__confirmCalls = [];'
    + 'window.confirm = function(message) {'
    + '  window.__confirmCalls.push(message);'
    + '  return ' + (answer ? 'true' : 'false') + ';'
    + '};'
  );

  const confirmCalls = () => driver.executeScript('return window.__confirmCalls || [];');

  it('registers a company', function(done) {
    register_new_user_func({application_host})
      .then(data => { driver = data.driver; done(); })
      .catch(done);
  });

  /*
    Found by email rather than by taking the first edit link on the page: the
    administrator who registered the company is on that list too, and deleting
    yourself is refused for its own reasons - which would look exactly like the
    confirmation working.
  */
  it('adds an employee to delete', function(done) {
    add_new_user_func({application_host, driver})
      .then(() => open_page_func({url: application_host + 'users/', driver}))
      .then(() => driver.executeScript(
        // The list shows names rather than emails, and the administrator who
        // registered the company is the only one with anything in the admin
        // column.
        'var row = Array.prototype.find.call('
        + '  document.querySelectorAll("tr"),'
        + '  function(tr) {'
        + '    var admin = tr.querySelector("td.employees-cell-isadmin");'
        + '    return admin && admin.textContent.trim() === "";'
        + '  }'
        + ');'
        + 'var link = row ? row.querySelector("a[href*=\'/users/edit/\']") : null;'
        + 'return link ? link.getAttribute("href") : null;'
      ))
      .then(href => {
        expect(href, 'the new employee is not on the list').to.be.a('string');
        employeeId = href.replace(/\/$/, '').split('/').pop();
        done();
      })
      .catch(done);
  });

  it('opens that employee', function(done) {
    open_page_func({url: application_host + 'users/edit/' + employeeId + '/', driver})
      .then(() => done())
      .catch(done);
  });

  /*
    The attribute carries the message, and something has to be listening for
    it. Both halves asserted: an attribute nobody reads is what the onsubmit
    one became.
  */
  it('carries the message as data rather than as script', function(done) {
    driver
      .executeScript(
        'var form = document.getElementById("add_new_user_frm");'
        + 'return JSON.stringify({'
        + '  message: form ? form.getAttribute("data-confirm-message") : null,'
        + '  inlineHandler: form ? form.hasAttribute("onsubmit") : null'
        + '});'
      )
      .then(raw => {
        const state = JSON.parse(raw);

        expect(state.message, 'the delete form asks nothing').to.be.a('string');
        expect(state.message).to.have.length.above(0);
        expect(state.inlineHandler, 'the inline handler is back, and the CSP will not run it')
          .to.equal(false);
        done();
      })
      .catch(done);
  });

  it('asks before deleting, and does not delete when told no', function(done) {
    stubConfirm(false)
      .then(() => driver.findElement(By.css('button#remove_btn')))
      .then(button => button.click())
      .then(() => driver.sleep(500))
      .then(() => confirmCalls())
      .then(calls => {
        expect(calls, 'the page deleted without asking').to.have.length.above(0);
        return open_page_func({url: application_host + 'users/', driver});
      })
      .then(() => driver.findElements(By.css('td.user_department')))
      .then(rows => {
        expect(rows.length, 'the employee was deleted after the dialog was dismissed')
          .to.equal(2);
        done();
      })
      .catch(done);
  });

  it('deletes when told yes', function(done) {
    open_page_func({url: application_host + 'users/edit/' + employeeId + '/', driver})
      .then(() => submit_form_func({
        driver,
        submit_button_selector : 'button#remove_btn',
        message : /Employee records were removed from the system/,
        confirm_dialog : true,
      }))
      .then(() => driver.findElements(By.css('td.user_department')))
      .then(rows => {
        expect(rows.length).to.equal(1);
        done();
      })
      .catch(done);
  });

  after(function(done) {
    driver.quit().then(() => done(), () => done());
  });
});
