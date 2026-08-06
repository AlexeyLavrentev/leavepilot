'use strict';

/* globals describe, it, before, after */

/*
 * Stage 8O — rendered Integration API Security Workspace contract.
 *
 * The test never prints or screenshots a generated token. Existing Premium
 * integration coverage remains responsible for bearer-endpoint authorization.
 */

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var webdriver = require('selenium-webdriver');
var By = webdriver.By;
var Key = webdriver.Key;
var until = webdriver.until;
var config = require('../../lib/config');
var registerNewUser = require('../../lib/register_new_user');
var openPage = require('../../lib/open_page');
const sizeViewport = require('../../lib/set_viewport');

var SCREEN_DIR = '/tmp/stage8o-integration-api';

async function setViewport(driver, width, height) {
  await sizeViewport(driver, { width: width, height: height });
  await driver.sleep(180);
}

async function openSettings(driver, host) {
  await openPage({ url: host + 'settings/company/integration-api/', driver: driver });
  await driver.wait(until.elementLocated(By.css('.integration-api-page')), 3000);
  await driver.sleep(100);
}

async function setLanguage(driver, host, locale) {
  await openPage({ url: host + 'language/' + locale, driver: driver });
  await openSettings(driver, host);
}

async function collapseMobileNav(driver) {
  var expanded = await driver.findElements(By.css('.navbar-toggle[aria-expanded="true"]'));
  if (expanded.length) {
    await expanded[0].click();
    await driver.sleep(220);
  }
}

async function setTheme(driver, theme) {
  var mobileToggle = await driver.findElements(By.css('.navbar-toggle'));
  if (mobileToggle.length && await mobileToggle[0].isDisplayed()) {
    var expanded = await mobileToggle[0].getAttribute('aria-expanded');
    if (expanded !== 'true') {
      await mobileToggle[0].click();
      await driver.sleep(180);
    }
  }
  await driver.findElement(By.css('#theme-menu .dropdown-toggle')).click();
  await driver.findElement(By.css('[data-theme-value="' + theme + '"]')).click();
  await driver.sleep(220);
  await collapseMobileNav(driver);
}

async function capture(driver, name) {
  if (!fs.existsSync(SCREEN_DIR)) fs.mkdirSync(SCREEN_DIR, { recursive: true });
  var target = path.join(SCREEN_DIR, name + '.png');
  fs.writeFileSync(target, await driver.takeScreenshot(), 'base64');
  assert(fs.statSync(target).size > 0, 'screenshot must be non-empty: ' + target);
}

var MOBILE_GEOMETRY = function () {
  var page = document.querySelector('.integration-api-page');
  var findings = [];
  var ranges = 0;
  var boxes = 0;
  var tolerance = 1;

  function hidden(element) {
    while (element && element !== document.body) {
      var style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' ||
          element.getAttribute('aria-hidden') === 'true') return true;
      element = element.parentElement;
    }
    return false;
  }

  function inspect(container, label) {
    if (hidden(container)) return;
    var boundary = container.getBoundingClientRect();
    if (container.scrollWidth > container.clientWidth + 2) {
      findings.push(label + ' scrollWidth ' + container.scrollWidth + ' > ' + container.clientWidth);
    }

    var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      if (!(node.nodeValue || '').trim() || hidden(node.parentElement)) continue;
      var range = document.createRange();
      range.selectNodeContents(node);
      var rects = range.getClientRects();
      for (var index = 0; index < rects.length; index++) {
        var rect = rects[index];
        if (!rect.width || !rect.height) continue;
        ranges++;
        if (rect.left < boundary.left - tolerance || rect.right > boundary.right + tolerance ||
            rect.left < -tolerance || rect.right > window.innerWidth + tolerance) {
          findings.push(label + ' text [' + rect.left + ', ' + rect.right +
            '] outside [' + boundary.left + ', ' + boundary.right + ']');
        }
      }
    }

    var elements = container.querySelectorAll(
      'input:not([type="hidden"]), button, label, p, strong, small, span:not(.fa)'
    );
    for (var item = 0; item < elements.length; item++) {
      var element = elements[item];
      if (hidden(element)) continue;
      var box = element.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      boxes++;
      if (box.left < boundary.left - tolerance || box.right > boundary.right + tolerance ||
          box.left < -tolerance || box.right > window.innerWidth + tolerance) {
        findings.push(label + ' ' + element.tagName + ' [' + box.left + ', ' + box.right +
          '] outside [' + boundary.left + ', ' + boundary.right + ']');
      }
    }
  }

  var surfaces = page.querySelectorAll('.surface');
  for (var index = 0; index < surfaces.length; index++) inspect(surfaces[index], 'surface-' + index);

  return {
    surfaces: surfaces.length,
    ranges: ranges,
    boxes: boxes,
    findings: findings,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    innerWidth: window.innerWidth
  };
};

async function assertMobileGeometry(driver, locale) {
  var result = await driver.executeScript(MOBILE_GEOMETRY);
  assert.strictEqual(result.surfaces, 2, '[' + locale + '] expected two surfaces');
  assert(result.ranges > 0 && result.boxes > 0,
    '[' + locale + '] geometry probe is vacuous: ' + JSON.stringify(result));
  assert(result.scrollWidth <= result.clientWidth + 1,
    '[' + locale + '] document overflow: ' + JSON.stringify(result));
  assert(result.scrollWidth <= result.innerWidth + 1,
    '[' + locale + '] viewport overflow: ' + JSON.stringify(result));
  assert.deepStrictEqual(result.findings, [],
    '[' + locale + '] geometry violations: ' + JSON.stringify(result.findings.slice(0, 20)));
}

describe('Integration API Security Workspace interaction contract (Stage 8O)', function () {
  this.timeout(config.get_execution_timeout());

  var driver;
  var host = config.get_application_host();

  before(function (done) {
    registerNewUser({ application_host: host }).then(function (data) {
      driver = data.driver;
      done();
    }, done);
  });

  after(async function () {
    if (driver) await driver.quit();
  });

  it('renders one protected form with the disabled state and hidden credential', async function () {
    await setViewport(driver, 1200, 850);
    await openSettings(driver, host);
    var state = await driver.executeScript(function () {
      var form = document.querySelector('.integration-api-form');
      return {
        headings: document.querySelectorAll('.integration-api-page h1').length,
        forms: document.querySelectorAll('.integration-api-page form').length,
        method: form.method.toLowerCase(),
        path: new URL(form.action).pathname,
        csrf: !!form.querySelector('input[name="_csrf"]'),
        surfaces: document.querySelectorAll('.integration-api-page .surface').length,
        enabled: document.getElementById('integration_api_enabled').checked,
        statusDisabled: document.querySelector('.integration-api-status').classList.contains('is-disabled'),
        tokenShown: !!document.getElementById('token-value'),
        tokenHidden: !!document.getElementById('token-value-hidden')
      };
    });
    assert.deepStrictEqual(state, {
      headings: 1,
      forms: 1,
      method: 'post',
      path: '/settings/company/integration-api/',
      csrf: true,
      surfaces: 2,
      enabled: false,
      statusDisabled: true,
      tokenShown: false,
      tokenHidden: true
    });
    var cacheControl = await driver.executeAsyncScript(function (done) {
      fetch(location.pathname, { credentials: 'same-origin' })
        .then(function (response) { done(response.headers.get('cache-control')); })
        .catch(function (error) { done('error:' + error.name); });
    });
    assert.strictEqual(cacheControl, 'no-store');
  });

  it('persists the existing enable checkbox through the existing save action', async function () {
    await openSettings(driver, host);
    await driver.findElement(By.id('integration_api_enabled')).click();
    await driver.findElement(By.id('save_settings_btn')).click();
    await driver.wait(until.elementLocated(By.css('.integration-api-status.is-enabled')), 3000);
    assert.strictEqual(await driver.findElement(By.id('integration_api_enabled')).isSelected(), true);
  });

  it('cancels regeneration before the legacy single-click submit handler', async function () {
    await openSettings(driver, host);
    await driver.executeScript(function () {
      window.__integrationConfirmCalls = 0;
      window.confirm = function (message) {
        window.__integrationConfirmCalls += 1;
        window.__integrationConfirmMessageLength = message.length;
        return false;
      };
    });
    await driver.findElement(By.id('regenerate_token_btn')).click();
    await driver.sleep(180);
    var result = await driver.executeScript(function () {
      return {
        calls: window.__integrationConfirmCalls,
        messageLength: window.__integrationConfirmMessageLength,
        disabled: document.getElementById('regenerate_token_btn').disabled,
        tokenShown: !!document.getElementById('token-value'),
        path: location.pathname
      };
    });
    assert.strictEqual(result.calls, 1);
    assert(result.messageLength > 20, 'localized confirmation must be meaningful');
    assert.strictEqual(result.disabled, false, 'cancelled rotation must leave the action usable');
    assert.strictEqual(result.tokenShown, false);
    assert.strictEqual(result.path, '/settings/company/integration-api/');
  });

  it('shows a regenerated token once, copies it without exposing its value, then hides it', async function () {
    await openSettings(driver, host);
    await driver.executeScript('window.confirm = function () { return true; }');
    await driver.findElement(By.id('regenerate_token_btn')).click();
    await driver.wait(until.elementLocated(By.id('token-value')), 3000);

    var tokenMeta = await driver.executeScript(function () {
      var token = document.getElementById('token-value');
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: function (value) {
            window.__copiedTokenLength = value.length;
            return Promise.resolve();
          }
        }
      });
      return {
        length: token.value.length,
        readonly: token.readOnly,
        autocomplete: token.autocomplete,
        describedBy: token.getAttribute('aria-describedby')
      };
    });
    assert(tokenMeta.length >= 40, 'one-time token must retain high entropy');
    assert.strictEqual(tokenMeta.readonly, true);
    assert.strictEqual(tokenMeta.autocomplete, 'off');
    assert.strictEqual(tokenMeta.describedBy, 'token_help');

    await driver.findElement(By.id('copy_token_btn')).click();
    await driver.wait(function () {
      return driver.executeScript(function () {
        return document.getElementById('copy_token_status').textContent.length > 0;
      });
    }, 2000);
    var copied = await driver.executeScript(function () {
      return {
        copiedLength: window.__copiedTokenLength,
        statusLength: document.getElementById('copy_token_status').textContent.length
      };
    });
    assert.strictEqual(copied.copiedLength, tokenMeta.length);
    assert(copied.statusLength > 0, 'copy result must be announced');

    await openSettings(driver, host);
    assert.strictEqual((await driver.findElements(By.id('token-value'))).length, 0);
    assert.strictEqual((await driver.findElements(By.id('token-value-hidden'))).length, 1);
  });

  it('keeps every mobile control reachable, visible and at least 44px high', async function () {
    await setViewport(driver, 390, 844);
    await openSettings(driver, host);
    await collapseMobileNav(driver);
    await driver.executeScript('document.querySelector(".integration-api-page").focus()');
    var visited = [];
    var entered = false;
    for (var index = 0; index < 40; index++) {
      await driver.actions().sendKeys(Key.TAB).perform();
      var focus = await driver.executeScript(function () {
        var active = document.activeElement;
        var rect = active.getBoundingClientRect();
        return {
          inside: !!active.closest('.integration-api-page'),
          id: active.id || '',
          height: rect.height,
          outline: getComputedStyle(active).outlineStyle,
          displayed: getComputedStyle(active).display !== 'none' && active.offsetParent !== null
        };
      });
      if (focus.inside) {
        entered = true;
        visited.push(focus);
      } else if (entered) {
        break;
      }
    }
    assert.deepStrictEqual(visited.map(function (item) { return item.id; }), [
      'integration_api_enabled', 'regenerate_token_btn', 'save_settings_btn'
    ]);
    assert(visited.every(function (item) { return item.displayed; }));
    assert(visited.filter(function (item) { return item.id !== 'integration_api_enabled'; })
      .every(function (item) { return item.height >= 43.5; }));
    assert(visited.some(function (item) { return item.outline !== 'none'; }),
      'Tab walk must expose a visible focus ring');
  });

  it('has no mobile overflow in EN, RU or KK', async function () {
    await setViewport(driver, 390, 844);
    for (const locale of ['en', 'ru', 'kk']) {
      await setLanguage(driver, host, locale);
      await assertMobileGeometry(driver, locale);
    }
    await setLanguage(driver, host, 'en');
  });

  it('keeps security guidance at WCAG AA contrast in light and dark', async function () {
    await setViewport(driver, 1200, 850);
    await openSettings(driver, host);
    for (const theme of ['light', 'dark']) {
      await setTheme(driver, theme);
      var ratios = await driver.executeScript(function () {
        function channels(value) {
          return (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
        }
        function luminance(value) {
          return channels(value).map(function (part) {
            part /= 255;
            return part <= 0.03928 ? part / 12.92 : Math.pow((part + 0.055) / 1.055, 2.4);
          }).reduce(function (sum, part, index) {
            return sum + part * [0.2126, 0.7152, 0.0722][index];
          }, 0);
        }
        function ratio(foreground, background) {
          var light = Math.max(luminance(foreground), luminance(background));
          var dark = Math.min(luminance(foreground), luminance(background));
          return (light + 0.05) / (dark + 0.05);
        }
        var warning = document.querySelector('.integration-api-warning');
        var note = document.querySelector('.integration-api-note');
        return {
          warning: ratio(getComputedStyle(warning).color, getComputedStyle(warning).backgroundColor),
          note: ratio(getComputedStyle(note).color, getComputedStyle(note).backgroundColor)
        };
      });
      assert(ratios.warning >= 4.5, theme + ' warning contrast: ' + ratios.warning);
      assert(ratios.note >= 4.5, theme + ' note contrast: ' + ratios.note);
    }
    await setTheme(driver, 'light');
  });

  it('neutralizes press feedback under emulated reduced motion', async function () {
    await openSettings(driver, host);
    await driver.sendDevToolsCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    });
    assert(await driver.executeScript(
      'return matchMedia("(prefers-reduced-motion: reduce)").matches'
    ));
    var button = await driver.findElement(By.id('save_settings_btn'));
    await driver.actions().move({ origin: button }).press().perform();
    var transform = await driver.executeScript(
      'return getComputedStyle(arguments[0]).transform', button
    );
    await driver.actions().release().perform();
    assert.strictEqual(transform, 'none');
    await driver.sendDevToolsCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }]
    });
  });

  it('captures an eight-case hidden-token visual matrix', async function () {
    var cases = [
      ['en', 1440, 900, 'light'],
      ['en', 1440, 900, 'dark'],
      ['en', 390, 844, 'light'],
      ['en', 390, 844, 'dark'],
      ['ru', 1440, 900, 'light'],
      ['ru', 390, 844, 'dark'],
      ['kk', 1440, 900, 'dark'],
      ['kk', 390, 844, 'light']
    ];
    for (var index = 0; index < cases.length; index++) {
      var item = cases[index];
      await setViewport(driver, item[1], item[2]);
      await setLanguage(driver, host, item[0]);
      await setTheme(driver, item[3]);
      assert.strictEqual((await driver.findElements(By.id('token-value'))).length, 0,
        'visual artifacts must never contain a plaintext token');
      await capture(driver, item[0] + '-' + item[1] + '-' + item[3]);
    }
    await setLanguage(driver, host, 'en');
    await setTheme(driver, 'light');
    assert.strictEqual(fs.readdirSync(SCREEN_DIR).filter(function (file) {
      return file.endsWith('.png');
    }).length, 8);
  });
});
