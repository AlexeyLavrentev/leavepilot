'use strict';

/* globals describe, it, before, after */

var path = require('path');
var fs = require('fs');
var assert = require('assert');
var webdriver = require('selenium-webdriver');
var By = webdriver.By;
var until = webdriver.until;
var Key = webdriver.Key;
var moment = require('moment');
var config = require('../../lib/config');
var models = require('../../../lib/model/db');
var registerNewUser = require('../../lib/register_new_user');
var addNewUser = require('../../lib/add_new_user');
var openPage = require('../../lib/open_page');
const sizeViewport = require('../../lib/set_viewport');

var SCREEN_DIR = '/tmp/stage8i-reports-detail';

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
  await sizeViewport(driver, { width: width, height: height });
  await driver.sleep(200);
}

async function setTheme(driver, theme) {
  var expand = await driver.executeScript(
    'var t=document.querySelector(".navbar-toggle");' +
    'return !!(t && getComputedStyle(t).display!=="none" && t.offsetWidth>0);'
  );
  if (expand) {
    await driver.findElement(By.css('.navbar-toggle')).click();
    await driver.sleep(150);
  }
  await driver.findElement(By.css('#theme-menu .dropdown-toggle')).click();
  await driver.findElement(By.css('[data-theme-value="' + theme + '"]')).click();
  await driver.sleep(350);
  if (expand && (await driver.findElements(By.css('.navbar-toggle[aria-expanded="true"]'))).length > 0) {
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

async function openReport(driver, host, route, query) {
  await openPage({ url: host + 'reports/' + route + '/' + (query || ''), driver: driver });
  await driver.wait(until.elementLocated(By.css('.report-detail-page')), 3000);
}

var MOBILE_GEOMETRY = function () {
  var findings = [];
  var checked = 0;
  var textRanges = 0;
  var tol = 1;
  var viewport = window.innerWidth;

  function hidden(el) {
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
    '.report-filter-surface, .reports-mobile-sort, .report-results-table tbody > tr > td'
  );
  for (var i = 0; i < blocks.length; i++) {
    if (hidden(blocks[i])) continue;
    checked++;
    var box = blocks[i].getBoundingClientRect();
    if (blocks[i].scrollWidth > blocks[i].clientWidth + 2) {
      findings.push({ kind: 'scroll', label: i, scrollWidth: blocks[i].scrollWidth, clientWidth: blocks[i].clientWidth });
    }
    var walker = document.createTreeWalker(blocks[i], NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode())) {
      if (!(node.nodeValue || '').trim() || hidden(node.parentElement)) continue;
      var range = document.createRange();
      range.selectNodeContents(node);
      var rects = range.getClientRects();
      for (var r = 0; r < rects.length; r++) {
        if (rects[r].width <= 0) continue;
        textRanges++;
        record('text', rects[r], box, i);
      }
    }
    var children = blocks[i].querySelectorAll('input, select, button, a, label, span, div');
    for (var c = 0; c < children.length; c++) {
      if (hidden(children[c])) continue;
      var childBox = children[c].getBoundingClientRect();
      if (childBox.width > 0) record('element', childBox, box, i + ':' + children[c].tagName);
    }
  }
  return {
    checked: checked,
    textRanges: textRanges,
    findings: findings,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  };
};

async function assertMobileGeometry(driver, label) {
  await driver.sleep(250);
  var result = await driver.executeScript(MOBILE_GEOMETRY);
  assert(result.checked > 2, label + ': geometry probe checked too few blocks');
  assert(result.textRanges > 2, label + ': geometry probe found no meaningful text');
  assert(result.scrollWidth <= result.clientWidth + 1,
    label + ': document overflow ' + result.scrollWidth + ' > ' + result.clientWidth);
  assert.strictEqual(result.findings.length, 0,
    label + ': clipped/overflowing content ' + JSON.stringify(result.findings.slice(0, 10)));
}

async function assertTabWalk(driver, pageClass) {
  await driver.executeScript('document.body.focus()');
  var entered = false;
  var exited = false;
  var visibleFocus = false;
  var hiddenFocus = [];
  for (var i = 0; i < 80; i++) {
    await driver.actions().sendKeys(Key.TAB).perform();
    var state = await driver.executeScript(function (selector) {
      var el = document.activeElement;
      if (!el) return null;
      var page = document.querySelector(selector);
      var cs = getComputedStyle(el);
      var r = el.getBoundingClientRect();
      return {
        inside: !!(page && page.contains(el)),
        hidden: cs.display === 'none' || cs.visibility === 'hidden' || r.width <= 0 || r.height <= 0,
        outline: cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px',
        cls: el.className || '',
        tag: el.tagName
      };
    }, pageClass);
    if (!state) continue;
    if (state.inside) {
      entered = true;
      visibleFocus = visibleFocus || state.outline;
      if (state.hidden) hiddenFocus.push(state.tag + '.' + state.cls);
    } else if (entered) {
      exited = true;
      break;
    }
  }
  assert(entered, 'Tab never entered ' + pageClass);
  assert(exited, 'Tab did not leave ' + pageClass + ' after traversing it');
  assert(visibleFocus, 'no visible focus indication observed in ' + pageClass);
  assert.deepStrictEqual(hiddenFocus, [], 'hidden focus targets: ' + hiddenFocus.join(', '));
}

describe('Reports detail workspace interaction, geometry & visual matrix (Stage 8I)', function () {
  this.timeout(config.get_execution_timeout());

  var driver;
  var host = config.get_application_host();
  var employee;
  var today;

  before(function (done) {
    registerNewUser({ application_host: host }).then(async function (data) {
      driver = data.driver;
      var admin = await models.User.findOne({ where: { email: data.email } });
      var employeeEmail = 'stage8i-' + Date.now() + '@test.com';
      await addNewUser({
        application_host: host,
        driver: driver,
        email: employeeEmail
      });
      employee = await models.User.findOne({ where: { email: employeeEmail } });
      assert(employee, 'new report employee should exist');
      await employee.update({ name: 'Alexandria', lastname: 'International-Report-Example' });
      var leaveType = await models.LeaveType.findOne({ where: { companyId: admin.companyId } });
      today = moment.utc();
      await models.Leave.create({
        userId: employee.id,
        approverId: admin.id,
        leaveTypeId: leaveType.id,
        status: models.Leave.status_approved(),
        date_start: today.format('YYYY-MM-DD'),
        date_end: today.format('YYYY-MM-DD')
      });
      done();
    }).catch(done);
  });

  after(function () {
    return driver.quit();
  });

  it('renders both scoped report workspaces with one heading and two surfaces', async function () {
    for (var route of ['allowancebytime', 'leaves']) {
      await setViewport(driver, 1440, 900);
      await openReport(driver, host, route);
      assert.strictEqual((await driver.findElements(By.css('main.report-detail-page'))).length, 1);
      assert.strictEqual((await driver.findElements(By.css('main h1'))).length, 1);
      assert.strictEqual((await driver.findElements(By.css('.report-filter-surface.surface'))).length, 1);
      assert.strictEqual((await driver.findElements(By.css('.report-results-surface.surface'))).length, 1);
      assert.strictEqual((await driver.findElements(By.css('.report-detail-page a[href="/reports/"]'))).length, 1);
    }
  });

  it('renders non-vacuous allowance and leaves result tables', async function () {
    await openReport(driver, host, 'allowancebytime');
    assert((await driver.findElements(By.css('[data-vpp-user-list-row]'))).length > 0, 'allowance rows missing');
    assert((await driver.findElements(By.css('[data-vpp-leave-type-id]'))).length > 0, 'dynamic leave type cells missing');
    await openReport(driver, host, 'leaves');
    assert((await driver.findElements(By.css('.report-leaves-table tbody tr'))).length > 0, 'leave rows missing');
  });

  it('submits filters with the exact GET query contract', async function () {
    await openReport(driver, host, 'allowancebytime');
    var month = today.format('YYYY-MM');
    await driver.executeScript(
      'document.querySelector("[name=start_date]").value=arguments[0];' +
      'document.querySelector("[name=end_date]").value=arguments[0];', month
    );
    await driver.findElement(By.css('.report-filter-actions button[type="submit"]:not([name="as-csv"])')).click();
    await driver.wait(function () { return driver.getCurrentUrl().then(function (u) { return u.indexOf('start_date=' + month) > -1; }); }, 3000);
    var allowanceUrl = await driver.getCurrentUrl();
    assert(allowanceUrl.indexOf('end_date=' + month) > -1, allowanceUrl);

    await openReport(driver, host, 'leaves');
    var day = today.format('YYYY-MM-DD');
    await driver.executeScript(
      'document.querySelector("[name=start_date]").value=arguments[0];' +
      'document.querySelector("[name=end_date]").value=arguments[0];', day
    );
    await driver.findElement(By.css('.report-filter-actions button[type="submit"]:not([name="as-csv"])')).click();
    await driver.wait(function () { return driver.getCurrentUrl().then(function (u) { return u.indexOf('start_date=' + day) > -1; }); }, 3000);
    var leavesUrl = await driver.getCurrentUrl();
    assert(leavesUrl.indexOf('end_date=' + day) > -1, leavesUrl);
  });

  it('keeps both CSV exports functional', async function () {
    for (var route of ['allowancebytime', 'leaves']) {
      await openReport(driver, host, route);
      var csv = await driver.executeAsyncScript(function (done) {
        fetch(location.pathname + location.search + (location.search ? '&' : '?') + 'as-csv=1', { credentials: 'same-origin' })
          .then(function (r) { return r.text().then(function (body) { done({ status: r.status, cd: r.headers.get('content-disposition'), body: body }); }); })
          .catch(function (e) { done({ error: String(e) }); });
      });
      assert.strictEqual(csv.status, 200, route + ' CSV status: ' + JSON.stringify(csv));
      assert(/attachment/i.test(csv.cd || ''), route + ' should return attachment: ' + csv.cd);
      assert(csv.body.indexOf(',') > -1, route + ' should return CSV content');
    }
  });

  it('desktop and mobile sorting submit an allowed sort key', async function () {
    await setViewport(driver, 1440, 900);
    await openReport(driver, host, 'leaves');
    await driver.findElement(By.css('.reports-desktop-sort-control[value="departmentName"]')).click();
    await driver.wait(function () { return driver.getCurrentUrl().then(function (u) { return u.indexOf('sort_by=departmentName') > -1; }); }, 3000);

    await setViewport(driver, 390, 844);
    await openReport(driver, host, 'leaves');
    assert.strictEqual(await driver.findElement(By.css('.reports-desktop-sort-control')).isDisplayed(), false,
      'desktop header sort must not remain a hidden mobile focus target');
    var details = await driver.findElement(By.css('.reports-mobile-sort'));
    await details.findElement(By.css('summary')).click();
    await details.findElement(By.css('button[value="status"]')).click();
    await driver.wait(function () { return driver.getCurrentUrl().then(function (u) { return u.indexOf('sort_by=status') > -1; }); }, 3000);
  });

  it('390px controls are touch-sized, tables become cards, and Tab has no hidden targets', async function () {
    for (var route of ['allowancebytime', 'leaves']) {
      await setViewport(driver, 390, 844);
      await openReport(driver, host, route);
      var metrics = await driver.executeScript(function () {
        var controls = document.querySelectorAll('.report-filter-surface input, .report-filter-surface select, .report-filter-actions .btn');
        var small = [];
        for (var i = 0; i < controls.length; i++) {
          var r = controls[i].getBoundingClientRect();
          if (r.width > 0 && (r.height < 44 || r.width < 44)) small.push({ tag: controls[i].tagName, width: r.width, height: r.height });
        }
        var row = document.querySelector('.report-results-table tbody tr');
        return { small: small, rowDisplay: row ? getComputedStyle(row).display : '', overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      assert.deepStrictEqual(metrics.small, [], route + ': undersized controls ' + JSON.stringify(metrics.small));
      assert(metrics.rowDisplay === 'grid' || metrics.rowDisplay === 'block', route + ': results did not become cards: ' + metrics.rowDisplay);
      assert(metrics.overflow <= 1, route + ': document overflow ' + metrics.overflow);
      await assertTabWalk(driver, '.report-detail-page');
    }
  });

  it('mobile geometry remains bounded in EN, RU and KK on both reports', async function () {
    await setViewport(driver, 390, 844);
    for (var locale of ['en', 'ru', 'kk']) {
      await openPage({ url: host + 'language/' + locale, driver: driver });
      for (var route of ['allowancebytime', 'leaves']) {
        await openReport(driver, host, route);
        if (route === 'leaves') await driver.findElement(By.css('.reports-mobile-sort summary')).click();
        await assertMobileGeometry(driver, locale + ':' + route);
      }
    }
    await openPage({ url: host + 'language/en', driver: driver });
  });

  it('reduced motion removes physical transforms in computed styles', async function () {
    await setViewport(driver, 1440, 900);
    await openReport(driver, host, 'leaves');
    await setReducedMotion(driver, true);
    assert(await driver.executeScript('return matchMedia("(prefers-reduced-motion: reduce)").matches'));
    var button = await driver.findElement(By.css('.report-filter-actions .btn-success'));
    await driver.actions().move({ origin: button }).press().perform();
    var transform = await driver.executeScript('return getComputedStyle(arguments[0]).transform', button);
    await driver.actions().release().perform();
    assert.strictEqual(transform, 'none', 'reduced-motion press transform: ' + transform);
    await setReducedMotion(driver, false);
  });

  it('captures a 12-shot light/dark, desktop/mobile and locale visual matrix', async function () {
    var cases = [
      ['allowancebytime', 'en', 'light', 1440, 'allowance_desktop_light'],
      ['allowancebytime', 'en', 'dark', 1440, 'allowance_desktop_dark'],
      ['allowancebytime', 'en', 'light', 390, 'allowance_mobile_light'],
      ['allowancebytime', 'en', 'dark', 390, 'allowance_mobile_dark'],
      ['allowancebytime', 'ru', 'light', 390, 'allowance_mobile_ru'],
      ['allowancebytime', 'kk', 'dark', 390, 'allowance_mobile_kk_dark'],
      ['leaves', 'en', 'light', 1440, 'leaves_desktop_light'],
      ['leaves', 'en', 'dark', 1440, 'leaves_desktop_dark'],
      ['leaves', 'en', 'light', 390, 'leaves_mobile_light'],
      ['leaves', 'en', 'dark', 390, 'leaves_mobile_dark'],
      ['leaves', 'ru', 'light', 390, 'leaves_mobile_ru'],
      ['leaves', 'kk', 'dark', 390, 'leaves_mobile_kk_dark']
    ];
    for (var i = 0; i < cases.length; i++) {
      var c = cases[i];
      await openPage({ url: host + 'language/' + c[1], driver: driver });
      await setViewport(driver, c[3], c[3] === 390 ? 844 : 900);
      await openReport(driver, host, c[0]);
      await setTheme(driver, c[2]);
      if (c[0] === 'leaves' && c[3] === 390) await driver.findElement(By.css('.reports-mobile-sort summary')).click();
      await driver.executeScript('window.scrollTo(0, 0)');
      await driver.sleep(100);
      await capture(driver, c[4]);
    }
    await openPage({ url: host + 'language/en', driver: driver });
    await setTheme(driver, 'light');
  });
});
