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
var buildDriver = require('../../lib/build_driver');
var registerNewUser = require('../../lib/register_new_user');
var logoutUser = require('../../lib/logout_user');

var SCREEN_DIR = '/tmp/stage8k-account-access';

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
  await driver.sleep(180);
}

async function setTheme(driver, theme) {
  var mobile = await driver.executeScript(
    'var t=document.querySelector(".navbar-toggle");' +
    'return !!(t && getComputedStyle(t).display!=="none" && t.offsetWidth>0);'
  );
  if (mobile) {
    await driver.findElement(By.css('.navbar-toggle')).click();
    await driver.sleep(180);
  }
  await driver.findElement(By.css('#theme-menu .dropdown-toggle')).click();
  await driver.findElement(By.css('[data-theme-value="' + theme + '"]')).click();
  await driver.sleep(240);
  if (mobile && (await driver.findElements(By.css('.navbar-toggle[aria-expanded="true"]'))).length > 0) {
    await driver.findElement(By.css('.navbar-toggle')).click();
    await driver.sleep(180);
  }
}

async function setReducedMotion(driver, enabled) {
  await driver.sendDevToolsCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: enabled ? 'reduce' : '' }]
  });
  await driver.sleep(80);
}

async function setLanguage(driver, host, locale) {
  await driver.get(host + 'language/' + locale);
  await driver.sleep(120);
}

async function openAccountPage(driver, host, route, resetToken) {
  var url = host + route;
  if (route === 'reset-password/' && resetToken) url += '?t=' + encodeURIComponent(resetToken);
  await driver.get(url);
  await driver.wait(until.elementLocated(By.css('main.account-access-page')), 4000);
}

var MOBILE_GEOMETRY = function () {
  var findings = [];
  var checked = 0;
  var ranges = 0;
  var viewport = window.innerWidth;
  var tol = 1;

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

  var blocks = document.querySelectorAll('.auth-intro-content, .account-access-card, .account-access-panel > .alert');
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
        ranges++;
        record('text', rects[r], box, i);
      }
    }
    var children = blocks[i].querySelectorAll('input, select, button, a, label, span, div, h1, h2, p');
    for (var c = 0; c < children.length; c++) {
      if (hidden(children[c])) continue;
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
  await driver.sleep(180);
  var result = await driver.executeScript(MOBILE_GEOMETRY);
  assert(result.checked >= 2, label + ': geometry probe is degenerate');
  assert(result.ranges > 4, label + ': no text ranges measured');
  assert(result.scrollWidth <= result.clientWidth + 1,
    label + ': document overflow ' + result.scrollWidth + ' > ' + result.clientWidth);
  assert.strictEqual(result.findings.length, 0,
    label + ': clipping/overflow findings ' + JSON.stringify(result.findings.slice(0, 12)));
}

async function assertTabWalk(driver, label) {
  await driver.executeScript('document.querySelector("main.account-access-page").focus()');
  var entered = false;
  var exited = false;
  var focusVisible = false;
  var hiddenTargets = [];
  for (var i = 0; i < 80; i++) {
    await driver.actions().sendKeys(Key.TAB).perform();
    var state = await driver.executeScript(function () {
      var active = document.activeElement;
      var page = document.querySelector('.account-access-page');
      if (!active) return null;
      var cs = getComputedStyle(active);
      var rect = active.getBoundingClientRect();
      return {
        inside: !!(page && page.contains(active)),
        hidden: cs.display === 'none' || cs.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0,
        focus: (cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px') || cs.boxShadow !== 'none',
        id: active.id || '',
        tag: active.tagName
      };
    });
    if (!state) continue;
    if (state.inside) {
      entered = true;
      focusVisible = focusVisible || state.focus;
      if (state.hidden) hiddenTargets.push(state.tag + '#' + state.id);
    } else if (entered) {
      exited = true;
      break;
    }
  }
  assert(entered, label + ': Tab never entered account page');
  assert(exited, label + ': Tab did not leave account page');
  assert(focusVisible, label + ': no visible focus treatment observed');
  assert.deepStrictEqual(hiddenTargets, [], label + ': hidden focus targets ' + hiddenTargets.join(', '));
}

describe('Account access interaction, geometry & visual matrix (Stage 8K)', function () {
  this.timeout(config.get_execution_timeout());

  var driver;
  var host = config.get_application_host();
  var registeredEmail;
  var resetToken;

  before(function () {
    driver = buildDriver();
    return setViewport(driver, 1440, 900);
  });

  after(async function () {
    if (driver) await driver.quit();
  });

  it('renders the shared shell on registration, SSO discovery and recovery', async function () {
    for (var route of ['register/', 'login/sso/', 'forgot-password/']) {
      await openAccountPage(driver, host, route);
      assert.strictEqual((await driver.findElements(By.css('main.account-access-page'))).length, 1);
      assert.strictEqual((await driver.findElements(By.css('main h1'))).length, 1);
      assert.strictEqual((await driver.findElements(By.css('.account-access-intro'))).length, 1);
      assert.strictEqual((await driver.findElements(By.css('.account-access-card'))).length, 1);
    }
  });

  it('uses native validation on SSO discovery and real pointer navigation back to password login', async function () {
    await openAccountPage(driver, host, 'login/sso/');
    await driver.findElement(By.css('#submit_sso_login')).click();
    assert(/\/login\/sso\/?$/.test(await driver.getCurrentUrl()), 'required email should block empty submit');
    await driver.findElement(By.css('#back_to_password_login')).click();
    await driver.wait(until.elementLocated(By.css('#local_login_form')), 4000);
    assert(/\/login\/?$/.test(await driver.getCurrentUrl()));
  });

  it('registers a real company through the preserved form', async function () {
    var data = await registerNewUser({ application_host: host, driver: driver });
    driver = data.driver;
    registeredEmail = data.email;
    var user = await models.User.findOne({ where: { email: registeredEmail } });
    assert(user, 'registered administrator should exist');
    resetToken = user.get_reset_password_token();
    assert(resetToken, 'reset token should be generated from the persisted user');
    await logoutUser({ application_host: host, driver: driver });
  });

  it('renders a real signed reset link without changing the password', async function () {
    await openAccountPage(driver, host, 'reset-password/', resetToken);
    assert.strictEqual((await driver.findElements(By.css('input[name="t"]'))).length, 1);
    assert.strictEqual(await driver.findElement(By.css('input[name="t"]')).getAttribute('value'), resetToken);
    assert.strictEqual((await driver.findElements(By.css('#password_inp'))).length, 1);
    assert.strictEqual((await driver.findElements(By.css('#confirm_password_inp'))).length, 1);
  });

  it('keeps forgot-password feedback generic for an unknown address', async function () {
    await openAccountPage(driver, host, 'forgot-password/');
    await driver.findElement(By.css('#email_inp')).sendKeys('stage8k-unknown-' + Date.now() + '@test.com');
    await driver.findElement(By.css('#submit_login')).click();
    await driver.wait(until.elementLocated(By.css('.alert-success')), 4000);
    var message = await driver.findElement(By.css('.alert-success')).getText();
    assert(message.length > 0, 'generic success feedback should be visible');
    assert(!/not found|unknown account|does not exist/i.test(message), 'feedback must not enumerate accounts: ' + message);
  });

  it('390px layouts have one-column registration, 44px targets and complete Tab traversal', async function () {
    await setViewport(driver, 390, 844);
    var routes = ['register/', 'login/sso/', 'forgot-password/', 'reset-password/'];
    for (var route of routes) {
      await openAccountPage(driver, host, route, resetToken);
      var metrics = await driver.executeScript(function () {
        var page = document.querySelector('.account-access-page');
        var controls = page.querySelectorAll('input:not([type=hidden]), select, button, a');
        var small = [];
        for (var i = 0; i < controls.length; i++) {
          var rect = controls[i].getBoundingClientRect();
          if (rect.width > 0 && (rect.width < 44 || rect.height < 44)) {
            small.push({ id: controls[i].id, tag: controls[i].tagName, width: rect.width, height: rect.height });
          }
        }
        var grid = page.querySelector('.account-access-field-grid');
        return {
          small: small,
          columns: grid ? getComputedStyle(grid).gridTemplateColumns : null,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
        };
      });
      assert.deepStrictEqual(metrics.small, [], route + ': undersized targets ' + JSON.stringify(metrics.small));
      if (route === 'register/') assert(metrics.columns.indexOf(' ') === -1, 'registration must be one column: ' + metrics.columns);
      assert(metrics.overflow <= 1, route + ': horizontal overflow ' + metrics.overflow);
      await assertTabWalk(driver, route);
    }
  });

  it('mobile geometry is bounded in EN, RU and KK across all four routes', async function () {
    await setViewport(driver, 390, 844);
    var routes = ['register/', 'login/sso/', 'forgot-password/', 'reset-password/'];
    for (var locale of ['en', 'ru', 'kk']) {
      await setLanguage(driver, host, locale);
      for (var route of routes) {
        await openAccountPage(driver, host, route, resetToken);
        await assertMobileGeometry(driver, locale + ':' + route);
      }
    }
    await setLanguage(driver, host, 'en');
  });

  it('computed reduced-motion behavior removes press transforms', async function () {
    await setViewport(driver, 1440, 900);
    await openAccountPage(driver, host, 'forgot-password/');
    await setReducedMotion(driver, true);
    assert(await driver.executeScript('return matchMedia("(prefers-reduced-motion: reduce)").matches'));
    var button = await driver.findElement(By.css('#submit_login'));
    await driver.actions().move({ origin: button }).press().perform();
    var transform = await driver.executeScript('return getComputedStyle(arguments[0]).transform', button);
    await driver.actions().release().perform();
    assert.strictEqual(transform, 'none', 'reduced-motion press transform: ' + transform);
    await setReducedMotion(driver, false);
  });

  it('key text meets WCAG AA contrast in both themes across all four routes', async function () {
    await setViewport(driver, 1440, 900);
    var routes = ['register/', 'login/sso/', 'forgot-password/', 'reset-password/'];
    for (var theme of ['light', 'dark']) {
      for (var route of routes) {
        await openAccountPage(driver, host, route, resetToken);
        await setTheme(driver, theme);
        var results = await driver.executeScript(function () {
          function rgba(value) {
            var match = String(value).match(/[\d.]+/g) || [];
            return {
              r: Number(match[0] || 0), g: Number(match[1] || 0), b: Number(match[2] || 0),
              a: match.length > 3 ? Number(match[3]) : 1
            };
          }
          function background(el) {
            while (el) {
              var color = rgba(getComputedStyle(el).backgroundColor);
              if (color.a > 0.98) return color;
              el = el.parentElement;
            }
            return { r: 255, g: 255, b: 255, a: 1 };
          }
          function luminance(color) {
            var values = [color.r, color.g, color.b].map(function (value) {
              value /= 255;
              return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
            });
            return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
          }
          function ratio(foreground, backgroundColor) {
            var light = Math.max(luminance(foreground), luminance(backgroundColor));
            var dark = Math.min(luminance(foreground), luminance(backgroundColor));
            return (light + 0.05) / (dark + 0.05);
          }
          var selectors = ['.auth-intro h1', '.auth-intro-copy', '.account-access-card h2', '.account-access-card label'];
          return selectors.map(function (selector) {
            var el = document.querySelector(selector);
            if (!el) return null;
            return {
              selector: selector,
              ratio: ratio(rgba(getComputedStyle(el).color), background(el)),
              text: el.textContent.trim()
            };
          }).filter(Boolean);
        });
        assert(results.length >= 3, theme + ':' + route + ': contrast probe is degenerate');
        for (var result of results) {
          assert(result.ratio >= 4.5,
            theme + ':' + route + ':' + result.selector + ' contrast ' + result.ratio.toFixed(2) + ' for ' + result.text);
        }
      }
    }
    await setTheme(driver, 'light');
  });

  it('captures a reviewed 13-shot visual matrix', async function () {
    var cases = [
      ['register/', 'en', 'light', 1440, 'register_desktop_light'],
      ['register/', 'en', 'dark', 1440, 'register_desktop_dark'],
      ['register/', 'en', 'light', 390, 'register_mobile_light'],
      ['register/', 'kk', 'dark', 390, 'register_mobile_kk_dark'],
      ['login/sso/', 'en', 'light', 1440, 'sso_desktop_light'],
      ['login/sso/', 'en', 'dark', 390, 'sso_mobile_dark'],
      ['login/sso/', 'ru', 'light', 390, 'sso_mobile_ru'],
      ['forgot-password/', 'en', 'light', 1440, 'forgot_desktop_light'],
      ['forgot-password/', 'en', 'dark', 390, 'forgot_mobile_dark'],
      ['forgot-password/', 'kk', 'light', 390, 'forgot_mobile_kk'],
      ['reset-password/', 'en', 'dark', 1440, 'reset_desktop_dark'],
      ['reset-password/', 'en', 'light', 390, 'reset_mobile_light'],
      ['reset-password/', 'ru', 'dark', 390, 'reset_mobile_ru_dark']
    ];
    for (var i = 0; i < cases.length; i++) {
      var c = cases[i];
      await setLanguage(driver, host, c[1]);
      await setViewport(driver, c[3], c[3] === 390 ? 844 : 900);
      await openAccountPage(driver, host, c[0], resetToken);
      await setTheme(driver, c[2]);
      await driver.executeScript('window.scrollTo(0, 0)');
      await driver.sleep(100);
      await capture(driver, c[4]);
    }
    await setLanguage(driver, host, 'en');
    await setTheme(driver, 'light');
  });
});
