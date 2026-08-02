'use strict';

/* globals describe, it, before, after */

var path = require('path');
var fs = require('fs');
var assert = require('assert');
var webdriver = require('selenium-webdriver');
var By = webdriver.By;
var until = webdriver.until;
var Key = webdriver.Key;
var config = require('../../lib/config');
var models = require('../../../lib/model/db');
var registerNewUser = require('../../lib/register_new_user');
var addNewUser = require('../../lib/add_new_user');
var openPage = require('../../lib/open_page');

var SCREEN_DIR = '/tmp/stage8j-employee-onboarding';
var IMPORT_FILE = '/tmp/stage8j-employee-import.csv';

function ensureScreenDir() {
  if (!fs.existsSync(SCREEN_DIR)) fs.mkdirSync(SCREEN_DIR, { recursive: true });
}

async function capture(driver, name) {
  ensureScreenDir();
  var file = path.join(SCREEN_DIR, name + '.png');
  fs.writeFileSync(file, await driver.takeScreenshot(), 'base64');
  assert(fs.statSync(file).size > 0, 'screenshot must be non-empty: ' + file);
}

async function setViewport(driver, width, height) {
  await driver.manage().window().setRect({ width: width, height: height });
  await driver.sleep(200);
}

async function setTheme(driver, theme) {
  var mobile = await driver.executeScript(
    'var t=document.querySelector(".navbar-toggle");' +
    'return !!(t && getComputedStyle(t).display!=="none" && t.offsetWidth>0);'
  );
  if (mobile) {
    await driver.findElement(By.css('.navbar-toggle')).click();
    await driver.sleep(250);
  }
  await driver.findElement(By.css('#theme-menu .dropdown-toggle')).click();
  await driver.findElement(By.css('[data-theme-value="' + theme + '"]')).click();
  await driver.sleep(350);
  if (mobile && (await driver.findElements(By.css('.navbar-toggle[aria-expanded="true"]'))).length > 0) {
    await driver.findElement(By.css('.navbar-toggle')).click();
    await driver.sleep(350);
  }
}

async function setReducedMotion(driver, enabled) {
  await driver.sendDevToolsCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: enabled ? 'reduce' : '' }]
  });
  await driver.sleep(80);
}

async function openOnboarding(driver, host, route) {
  await openPage({ url: host + 'users/' + route + '/', driver: driver });
  await driver.wait(until.elementLocated(By.css('.employee-onboarding-page')), 3000);
}

var MOBILE_GEOMETRY = function () {
  var findings = [];
  var checked = 0;
  var ranges = 0;
  var viewport = window.innerWidth;
  var tol = 1;

  function isHidden(el) {
    while (el && el !== document.body) {
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || el.getAttribute('aria-hidden') === 'true') return true;
      el = el.parentElement;
    }
    return false;
  }

  function record(kind, rect, box, label) {
    if (rect.left < box.left - tol || rect.right > box.right + tol || rect.left < -tol || rect.right > viewport + tol) {
      findings.push({ kind: kind, label: label, left: rect.left, right: rect.right, boxLeft: box.left, boxRight: box.right });
    }
  }

  var blocks = document.querySelectorAll(
    '.employee-onboarding-surface, .employee-onboarding-actions, .employee-import-step-content, .employee-import-file-field'
  );
  for (var i = 0; i < blocks.length; i++) {
    if (isHidden(blocks[i])) continue;
    checked++;
    var box = blocks[i].getBoundingClientRect();
    if (blocks[i].scrollWidth > blocks[i].clientWidth + 2) {
      findings.push({ kind: 'scroll', label: i, scrollWidth: blocks[i].scrollWidth, clientWidth: blocks[i].clientWidth });
    }
    var walker = document.createTreeWalker(blocks[i], NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode())) {
      if (!(node.nodeValue || '').trim() || isHidden(node.parentElement)) continue;
      var range = document.createRange();
      range.selectNodeContents(node);
      var rects = range.getClientRects();
      for (var r = 0; r < rects.length; r++) {
        if (rects[r].width <= 0) continue;
        ranges++;
        record('text', rects[r], box, i);
      }
    }
    var children = blocks[i].querySelectorAll('input, select, button, a, label, span, div, h2, h3, p');
    for (var c = 0; c < children.length; c++) {
      if (isHidden(children[c])) continue;
      var child = children[c].getBoundingClientRect();
      if (child.width > 0) record('element', child, box, i + ':' + children[c].tagName);
    }
  }
  return {
    checked: checked,
    ranges: ranges,
    findings: findings,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  };
};

async function assertMobileGeometry(driver, label) {
  await driver.sleep(250);
  var result = await driver.executeScript(MOBILE_GEOMETRY);
  assert(result.checked > 1, label + ': geometry probe is degenerate');
  assert(result.ranges > 3, label + ': no text ranges measured');
  assert(result.scrollWidth <= result.clientWidth + 1,
    label + ': document overflow ' + result.scrollWidth + ' > ' + result.clientWidth);
  assert.strictEqual(result.findings.length, 0,
    label + ': clipping/overflow findings ' + JSON.stringify(result.findings.slice(0, 12)));
}

async function assertTabWalk(driver) {
  await driver.executeScript('document.body.focus()');
  var entered = false;
  var exited = false;
  var focusVisible = false;
  var hiddenTargets = [];
  for (var i = 0; i < 100; i++) {
    await driver.actions().sendKeys(Key.TAB).perform();
    var state = await driver.executeScript(function () {
      var active = document.activeElement;
      var page = document.querySelector('.employee-onboarding-page');
      if (!active) return null;
      var cs = getComputedStyle(active);
      var rect = active.getBoundingClientRect();
      return {
        inside: !!(page && page.contains(active)),
        hidden: cs.display === 'none' || cs.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0,
        outline: cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px',
        tag: active.tagName,
        id: active.id || ''
      };
    });
    if (!state) continue;
    if (state.inside) {
      entered = true;
      focusVisible = focusVisible || state.outline;
      if (state.hidden) hiddenTargets.push(state.tag + '#' + state.id);
    } else if (entered) {
      exited = true;
      break;
    }
  }
  assert(entered, 'Tab never entered onboarding page');
  assert(exited, 'Tab did not leave onboarding page');
  assert(focusVisible, 'no visible focus ring observed');
  assert.deepStrictEqual(hiddenTargets, [], 'hidden focus targets: ' + hiddenTargets.join(', '));
}

describe('Employee onboarding interaction, geometry & visual matrix (Stage 8J)', function () {
  this.timeout(config.get_execution_timeout());

  var driver;
  var host = config.get_application_host();
  var admin;

  before(function (done) {
    registerNewUser({ application_host: host }).then(async function (data) {
      driver = data.driver;
      admin = await models.User.findOne({ where: { email: data.email } });
      assert(admin, 'registered admin should exist');
      done();
    }).catch(done);
  });

  after(async function () {
    if (driver) await driver.quit();
    if (fs.existsSync(IMPORT_FILE)) fs.unlinkSync(IMPORT_FILE);
  });

  it('renders one scoped page with reciprocal navigation on both routes', async function () {
    for (var route of ['add', 'import']) {
      await setViewport(driver, 1440, 900);
      await openOnboarding(driver, host, route);
      assert.strictEqual((await driver.findElements(By.css('main.employee-onboarding-page'))).length, 1);
      assert.strictEqual((await driver.findElements(By.css('main h1'))).length, 1);
      assert.strictEqual((await driver.findElements(By.css('.page-heading'))).length, 1);
      assert.strictEqual((await driver.findElements(By.css('.employee-onboarding-breadcrumb'))).length, 1);
      assert.strictEqual((await driver.findElements(By.css('.employee-onboarding-switch'))).length, 1);
    }
  });

  it('real pointer navigation switches between single and CSV onboarding', async function () {
    await openOnboarding(driver, host, 'add');
    await driver.findElement(By.css('#import_users_btn')).click();
    await driver.wait(until.elementLocated(By.css('.employee-onboarding-import')), 3000);
    assert(/\/users\/import\/?$/.test(await driver.getCurrentUrl()));
    await driver.findElement(By.css('#add_new_department')).click();
    await driver.wait(until.elementLocated(By.css('.employee-onboarding-single')), 3000);
    assert(/\/users\/add\/?$/.test(await driver.getCurrentUrl()));
  });

  it('creates a single employee through the preserved form contract', async function () {
    var email = 'stage8j-single-' + Date.now() + '@test.com';
    await addNewUser({ application_host: host, driver: driver, email: email });
    var created = await models.User.findOne({ where: { email: email } });
    assert(created, 'single employee should be created');
    assert.strictEqual(created.companyId, admin.companyId);
  });

  it('sample CSV POST returns a downloadable CSV attachment', async function () {
    await openOnboarding(driver, host, 'import');
    var result = await driver.executeAsyncScript(function (done) {
      var token = document.querySelector('#users_import_sample_form [name="_csrf"]').value;
      fetch('/users/import-sample/', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '_csrf=' + encodeURIComponent(token)
      }).then(function (response) {
        return response.text().then(function (body) {
          done({ status: response.status, disposition: response.headers.get('content-disposition'), body: body });
        });
      }).catch(function (error) { done({ error: String(error) }); });
    });
    assert.strictEqual(result.status, 200, JSON.stringify(result));
    assert(/attachment/i.test(result.disposition || ''), result.disposition);
    assert(/^email,lastname,name,department/m.test(result.body), result.body.slice(0, 100));
  });

  it('imports an employee through the real multipart upload form', async function () {
    var email = 'stage8j-import-' + Date.now() + '@test.com';
    fs.writeFileSync(IMPORT_FILE,
      'email,lastname,name,department\n' + email + ',Import,Runtime,Sales\n', 'utf8');
    await openOnboarding(driver, host, 'import');
    await driver.findElement(By.css('#users_input_inp')).sendKeys(IMPORT_FILE);
    await driver.findElement(By.css('#submit_users_btn')).click();
    await driver.wait(until.elementLocated(By.css('.alert-success')), 5000);
    var imported = await models.User.findOne({ where: { email: email } });
    assert(imported, 'CSV employee should be imported');
    assert.strictEqual(imported.companyId, admin.companyId);
  });

  it('390px layout has one-column fields, 44px controls and complete Tab traversal', async function () {
    for (var route of ['add', 'import']) {
      await setViewport(driver, 390, 844);
      await openOnboarding(driver, host, route);
      var metrics = await driver.executeScript(function () {
        var controls = document.querySelectorAll(
          '.employee-onboarding-page input:not([type=hidden]):not([type=checkbox]), ' +
          '.employee-onboarding-page select, .employee-onboarding-page .btn, ' +
          '.employee-onboarding-page .employee-onboarding-option > label'
        );
        var small = [];
        for (var i = 0; i < controls.length; i++) {
          var rect = controls[i].getBoundingClientRect();
          if (rect.width > 0 && (rect.width < 44 || rect.height < 44)) {
            small.push({ id: controls[i].id, width: rect.width, height: rect.height });
          }
        }
        var fields = document.querySelector('.employee-onboarding-fields');
        return {
          small: small,
          fieldColumns: fields ? getComputedStyle(fields).gridTemplateColumns : null,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
        };
      });
      assert.deepStrictEqual(metrics.small, [], route + ': undersized controls ' + JSON.stringify(metrics.small));
      if (route === 'add') assert(metrics.fieldColumns.indexOf(' ') === -1, 'add fields should be one column: ' + metrics.fieldColumns);
      assert(metrics.overflow <= 1, route + ': horizontal overflow ' + metrics.overflow);
      await assertTabWalk(driver);
    }
  });

  it('mobile geometry is bounded in EN, RU and KK on both routes', async function () {
    await setViewport(driver, 390, 844);
    for (var locale of ['en', 'ru', 'kk']) {
      await openPage({ url: host + 'language/' + locale, driver: driver });
      for (var route of ['add', 'import']) {
        await openOnboarding(driver, host, route);
        await assertMobileGeometry(driver, locale + ':' + route);
      }
    }
    await openPage({ url: host + 'language/en', driver: driver });
  });

  it('computed reduced-motion behavior removes press transforms', async function () {
    await setViewport(driver, 1440, 900);
    await openOnboarding(driver, host, 'import');
    await setReducedMotion(driver, true);
    assert(await driver.executeScript('return matchMedia("(prefers-reduced-motion: reduce)").matches'));
    var button = await driver.findElement(By.css('#users_import_sample_btn'));
    await driver.actions().move({ origin: button }).press().perform();
    var transform = await driver.executeScript('return getComputedStyle(arguments[0]).transform', button);
    await driver.actions().release().perform();
    assert.strictEqual(transform, 'none', 'reduced-motion press transform: ' + transform);
    await setReducedMotion(driver, false);
  });

  it('captures a 12-shot visual matrix across routes, themes and locales', async function () {
    var cases = [
      ['add', 'en', 'light', 1440, 'single_desktop_light'],
      ['add', 'en', 'dark', 1440, 'single_desktop_dark'],
      ['add', 'en', 'light', 390, 'single_mobile_light'],
      ['add', 'en', 'dark', 390, 'single_mobile_dark'],
      ['add', 'ru', 'light', 390, 'single_mobile_ru'],
      ['add', 'kk', 'dark', 390, 'single_mobile_kk_dark'],
      ['import', 'en', 'light', 1440, 'import_desktop_light'],
      ['import', 'en', 'dark', 1440, 'import_desktop_dark'],
      ['import', 'en', 'light', 390, 'import_mobile_light'],
      ['import', 'en', 'dark', 390, 'import_mobile_dark'],
      ['import', 'ru', 'light', 390, 'import_mobile_ru'],
      ['import', 'kk', 'dark', 390, 'import_mobile_kk_dark']
    ];
    for (var i = 0; i < cases.length; i++) {
      var c = cases[i];
      await openPage({ url: host + 'language/' + c[1], driver: driver });
      await setViewport(driver, c[3], c[3] === 390 ? 844 : 900);
      await openOnboarding(driver, host, c[0]);
      await setTheme(driver, c[2]);
      await driver.executeScript('window.scrollTo(0, 0)');
      await driver.sleep(100);
      await capture(driver, c[4]);
    }
    await openPage({ url: host + 'language/en', driver: driver });
    await setTheme(driver, 'light');
  });
});
