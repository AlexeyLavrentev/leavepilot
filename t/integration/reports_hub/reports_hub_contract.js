'use strict';

/* globals describe, it, before, after */

var path   = require('path'),
    fs     = require('fs'),
    assert = require('assert'),
    webdriver = require('selenium-webdriver'),
    By     = webdriver.By,
    until   = webdriver.until,
    Key     = webdriver.Key,
    config = require('../../lib/config'),
    register_new_user_func = require('../../lib/register_new_user'),
    open_page_func = require('../../lib/open_page');

var SCREEN_DIR = '/tmp/screens';

function ensureScreenDir() {
  if (!fs.existsSync(SCREEN_DIR)) {
    fs.mkdirSync(SCREEN_DIR, { recursive: true });
  }
}

// Open the Bootstrap theme dropdown via its real toggle (the <a> inside #theme-menu).
// On collapsed navbars (mobile), expand .navbar-toggle first so the menu is interactable,
// then collapse it again afterwards for a clean screenshot.
async function setTheme(driver, theme /* 'light' | 'dark' */) {
  var navbarNeedsExpand = await driver.executeScript(
    'var t=document.querySelector(".navbar-toggle");' +
    'return !!(t && getComputedStyle(t).display!=="none" && t.offsetWidth>0);'
  );
  if (navbarNeedsExpand) {
    await driver.findElement(By.css('.navbar-toggle')).click();
    await driver.sleep(300);
  }
  await driver.findElement(By.css('#theme-menu .dropdown-toggle')).click();
  await driver.wait(until.elementLocated(By.css('[data-theme-value="' + theme + '"]')), 1000);
  await driver.findElement(By.css('[data-theme-value="' + theme + '"]')).click();
  await driver.sleep(150);
  if (theme === 'dark') {
    await driver.wait(until.elementLocated(By.css('html[data-theme="dark"]')), 2000);
  } else {
    await driver.wait(function () {
      return driver.executeScript('return document.documentElement.getAttribute("data-theme") === null;');
    }, 2000);
  }
  if (navbarNeedsExpand) {
    await driver.findElement(By.css('.navbar-toggle')).click();
    await driver.sleep(200);
  }
}

async function setViewport(driver, w, h) {
  await driver.manage().window().setRect({ width: w, height: h });
  await driver.sleep(250);
}

async function capture(driver, name) {
  ensureScreenDir();
  var image = await driver.takeScreenshot();
  var file = path.join(SCREEN_DIR, name + '.png');
  fs.writeFileSync(file, image, 'base64');
  assert(fs.statSync(file).size > 0, 'screenshot must be non-empty: ' + file);
  return file;
}

// Toggle prefers-reduced-motion via the Chrome DevTools Protocol. selenium-webdriver 4.45
// has no top-level driver.setEmulatedMedia; the chromedriver CDP bridge is exposed through
// driver.sendDevToolsCommand(cmd, params). The modern DevTools method is Emulation.setEmulatedMedia
// with a `features` array (matches puppeteer's EmulationManager). Pass value '' to clear.
/*
 * Headless Chrome reports no hover-capable pointer, so `@media (hover: hover)`
 * never matches and the card elevation this contract measures cannot appear —
 * however real the synthetic pointer is. Every emulation call therefore states
 * the pointer as well; `setEmulatedMedia` replaces the whole feature list, so
 * they have to travel together.
 */
async function setEmulatedMedia(driver, {reducedMotion} = {}) {
  await driver.sendDevToolsCommand('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : '' },
      { name: 'hover', value: 'hover' },
      { name: 'pointer', value: 'fine' },
    ]
  });
  // Yield so the emulated media propagates to pending media-query recomputations.
  await driver.sleep(80);
}

async function setReducedMotion(driver, enabled /* true | false */) {
  await setEmulatedMedia(driver, {reducedMotion: enabled});
}

describe('Reports Hub interaction & geometry contract (Stage 8B)', function () {

  this.timeout(config.get_execution_timeout());

  var driver;
  var application_host = config.get_application_host();

  before(function (done) {
    register_new_user_func({ application_host: application_host }).then(function (data) {
      driver = data.driver;
      done();
    }, done);
  });

  after(function () {
    return driver.quit();
  });

  async function openReports() {
    await open_page_func({ url: application_host + 'reports/', driver: driver });
    await driver.wait(until.elementLocated(By.css('.reports-hub')), 2000);
  }

  it('renders the scoped hub with two report cards', async function () {
    await openReports();
    var cards = await driver.findElements(By.css('.report-card'));
    assert.strictEqual(cards.length, 2, 'expected exactly two report cards');
    var hrefs = await Promise.all(cards.map(function (c) { return c.getAttribute('href'); }));
    assert(hrefs.indexOf(application_host + 'reports/allowancebytime/') > -1, 'allowancebytime href present: ' + hrefs);
    assert(hrefs.indexOf(application_host + 'reports/leaves/') > -1, 'leaves href present: ' + hrefs);
  });

  it('each card is a >=44px tap target', async function () {
    await setViewport(driver, 1440, 900);
    await openReports();
    var cards = await driver.findElements(By.css('.report-card'));
    for (var i = 0; i < cards.length; i++) {
      var r = await driver.executeScript('var el=arguments[0]; var b=el.getBoundingClientRect(); return {w:b.width,h:b.height};', cards[i]);
      assert(r.h >= 44, 'card ' + i + ' height ' + r.h + ' < 44');
      assert(r.w >= 44, 'card ' + i + ' width ' + r.w + ' < 44');
    }
  });

  // H1 — REAL keyboard Tab (not JS .focus()). Focus body, then send real Tab keystrokes until
  // document.activeElement is a .report-card, then read its COMPUTED focus outline. A real Tab
  // triggers :focus-visible (the scoped 2px ring); JS .focus() may not.
  it('Tab produces a visible focus ring on a report card', async function () {
    await setViewport(driver, 1440, 900);
    await openReports();
    // Start from a known, non-card focusable position: focus <body> itself.
    await driver.executeScript('document.body.focus();');
    await driver.sleep(120);
    var landed = false;
    for (var i = 0; i < 30; i++) {
      // Real synthesized keyboard event, NOT executeScript(.focus()).
      await driver.actions().sendKeys(Key.TAB).perform();
      await driver.sleep(50);
      var ae = await driver.executeScript(
        'var el=document.activeElement; return el ? (el.tagName + "|" + el.className) : "";'
      );
      if (/report-card/.test(ae)) { landed = true; break; }
    }
    assert(landed, 'real Tab never focused a .report-card within 30 presses');
    var focusedOutline = await driver.executeScript(
      'var el=document.activeElement; if(!el) return null;' +
      'var cs=getComputedStyle(el); return {tag:el.tagName, cls:el.className, ' +
      'outlineWidth:cs.outlineWidth, outlineStyle:cs.outlineStyle, outlineColor:cs.outlineColor};'
    );
    assert(/report-card/.test(focusedOutline.cls || ''), 'focused element should be a report card, got: ' + JSON.stringify(focusedOutline));
    assert(focusedOutline.outlineWidth !== '0px', 'expected non-zero outline on Tab-focused card, got ' + focusedOutline.outlineWidth);
    assert(focusedOutline.outlineStyle !== 'none', 'expected visible outline-style on Tab-focused card, got ' + focusedOutline.outlineStyle);
  });

  it('Enter on the allowance card navigates to /reports/allowancebytime/', async function () {
    await setViewport(driver, 1440, 900);
    await openReports();
    var card = await driver.findElement(By.css('.report-card[href$="reports/allowancebytime/"]'));
    await driver.executeScript('arguments[0].focus();', card);
    await driver.actions().sendKeys(Key.ENTER).perform();
    await driver.wait(function () {
      return driver.getCurrentUrl().then(function (u) { return /\/reports\/allowancebytime\/?(\?|$)/.test(u); });
    }, 5000);
  });

  it('Enter on the leaves card navigates to /reports/leaves/', async function () {
    await setViewport(driver, 1440, 900);
    await openReports();
    var card = await driver.findElement(By.css('.report-card[href$="reports/leaves/"]'));
    await driver.executeScript('arguments[0].focus();', card);
    await driver.actions().sendKeys(Key.ENTER).perform();
    await driver.wait(function () {
      return driver.getCurrentUrl().then(function (u) { return /\/reports\/leaves\/?(\?|$)/.test(u); });
    }, 5000);
  });

  // H2 — REAL pointer click (Selenium .click(), a synthesized mouse click — not JS .click() and
  // not Enter). One card at a time, then wait for the URL to reach the card's route.
  it('real pointer click on the allowance card navigates to /reports/allowancebytime/', async function () {
    await setViewport(driver, 1440, 900);
    await openReports();
    var card = await driver.findElement(By.css('.report-card[href$="reports/allowancebytime/"]'));
    // Real mouse click (pointer down+up synthesized by the driver).
    await card.click();
    await driver.wait(function () {
      return driver.getCurrentUrl().then(function (u) { return /\/reports\/allowancebytime\/?(\?|$)/.test(u); });
    }, 5000);
  });

  it('real pointer click on the leaves card navigates to /reports/leaves/', async function () {
    await setViewport(driver, 1440, 900);
    await openReports();
    var card = await driver.findElement(By.css('.report-card[href$="reports/leaves/"]'));
    // Real mouse click (pointer down+up synthesized by the driver).
    await card.click();
    await driver.wait(function () {
      return driver.getCurrentUrl().then(function (u) { return /\/reports\/leaves\/?(\?|$)/.test(u); });
    }, 5000);
  });

  it('desktop: two cards in two columns with equal height within 1px', async function () {
    await setViewport(driver, 1440, 900);
    await openReports();
    await driver.sleep(200);
    var g = await driver.executeScript(function () {
      var cards = document.querySelectorAll('.reports-hub .report-card');
      var a = cards[0].getBoundingClientRect();
      var b = cards[1].getBoundingClientRect();
      return {
        aLeft: a.left, aRight: a.right, aTop: a.top, aBottom: a.bottom, aHeight: a.height,
        bLeft: b.left, bRight: b.right, bTop: b.top, bBottom: b.bottom, bHeight: b.height,
        sideBySide: Math.abs(a.top - b.top) < 1
      };
    });
    assert(g.sideBySide, 'desktop: cards should be side by side (same top), got aTop=' + g.aTop + ' bTop=' + g.bTop);
    assert(Math.abs(g.aHeight - g.bHeight) <= 1, 'desktop: equal height within 1px, got ' + g.aHeight + ' vs ' + g.bHeight);
  });

  it('mobile (390px): single column (stacked), no horizontal overflow, text within viewport', async function () {
    await setViewport(driver, 390, 844);
    await openReports();
    await driver.sleep(300);
    var g = await driver.executeScript(function () {
      var de = document.documentElement;
      var cards = document.querySelectorAll('.reports-hub .report-card');
      var a = cards[0].getBoundingClientRect();
      var b = cards[1].getBoundingClientRect();
      // sample a description text node to check content bounds
      var desc = document.querySelector('.report-card-desc');
      var dr = desc ? desc.getBoundingClientRect() : null;
      return {
        scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, innerWidth: window.innerWidth,
        stacked: Math.abs(a.left - b.left) < 1, // same left edge => same column
        aTop: a.top, bTop: b.top, // b below a
        descRight: dr ? dr.right : null,
        viewportWidth: window.innerWidth
      };
    });
    assert(g.scrollWidth <= g.clientWidth + 1, 'horizontal overflow: scrollWidth=' + g.scrollWidth + ' > clientWidth=' + g.clientWidth);
    assert(g.scrollWidth <= g.innerWidth + 1, 'horizontal overflow: scrollWidth=' + g.scrollWidth + ' > innerWidth=' + g.innerWidth);
    assert(g.stacked, 'mobile: cards should stack in one column (same left), got aLeft vs bLeft differ');
    assert(g.bTop > g.aTop, 'mobile: second card below first');
    if (g.descRight !== null) {
      assert(g.descRight <= g.viewportWidth + 1, 'description text right edge (' + g.descRight + ') exceeds viewport (' + g.viewportWidth + ')');
    }
  });

  // H3 — reduced-motion: EMULATE the media via Chrome CDP (driver.sendDevToolsCommand) and assert
  // the COMPUTED transform of a hovered card is `none`. The brief allows either CDP method; the
  // working one in selenium-webdriver 4.45 / chromedriver is Emulation.setEmulatedMedia with a
  // `features` array. We prove the emulation actually applied via matchMedia, then verify behavior.
  it('reduced-motion: emulated media suppresses the hover transform to none', async function () {
    await setViewport(driver, 1440, 900);
    await openReports();

    // 1) Baseline: under default media, hovering a card lifts it (translateY(-1px)).
    var card = await driver.findElement(By.css('.report-card'));
    await setEmulatedMedia(driver);
    var body = await driver.findElement(By.css('body'));
    await driver.actions().move({ origin: body }).perform();
    await driver.sleep(150);
    var baseline = await driver.executeScript(
      'var el=arguments[0]; return {transform:getComputedStyle(el).transform, hover:el.matches(":hover")};',
      card
    );
    await driver.actions().move({ origin: card }).perform();
    await driver.sleep(200);
    var hoverDefault = await driver.executeScript(
      'var el=arguments[0]; return {transform:getComputedStyle(el).transform, hover:el.matches(":hover"),'
      + ' hoverCapable:window.matchMedia("(hover: hover)").matches,'
      + ' finePointer:window.matchMedia("(pointer: fine)").matches};',
      card
    );
    assert(hoverDefault.hover, 'precondition: pointer should hover the card, got :hover=false');
    // The elevation lives behind `@media (hover: hover)`, so a browser that
    // reports no hover-capable pointer produces no transform however real the
    // pointer is. Name that in the failure rather than leaving it to guesswork.
    assert(hoverDefault.hoverCapable,
      'precondition: browser should report a hover-capable pointer, got (hover: hover)=false, '
      + '(pointer: fine)=' + hoverDefault.finePointer);
    assert(hoverDefault.transform !== 'none' && hoverDefault.transform !== 'matrix(1, 0, 0, 1, 0, 0)',
      'baseline: hovered card should have a non-identity transform under default media, got ' + hoverDefault.transform);

    // 2) Emulate prefers-reduced-motion: reduce, prove it applied via matchMedia.
    await setReducedMotion(driver, true);
    var mqApplied = await driver.executeScript('return window.matchMedia("(prefers-reduced-motion: reduce)").matches');
    assert(mqApplied, 'CDP Emulation.setEmulatedMedia(reduce) did not apply (matchMedia still false)');

    // 3) Hover again under reduced-motion and read the COMPUTED transform. Re-find the element to
    //    avoid a stale reference after the CDP round-trip.
    card = await driver.findElement(By.css('.report-card'));
    await driver.actions().move({ origin: card }).perform();
    await driver.sleep(200);
    var hoverRM = await driver.executeScript(
      'var el=arguments[0]; return {transform:getComputedStyle(el).transform, hover:el.matches(":hover")};',
      card
    );
    assert(hoverRM.hover, 'precondition under RM: pointer should hover the card, got :hover=false');
    assert(hoverRM.transform === 'none',
      'reduced-motion: hovered card transform must be suppressed to "none", got ' + hoverRM.transform);

    // 4) Reset the emulated media so later tests are unaffected, and prove it cleared.
    await setReducedMotion(driver, false);
    var mqCleared = await driver.executeScript('return window.matchMedia("(prefers-reduced-motion: reduce)").matches');
    assert(!mqCleared, 'CDP reset did not clear prefers-reduced-motion (matchMedia still true)');

    // 5) Secondary backup assertion: the loaded CSS contains the scoped reduced-motion rule.
    var hasRule = await driver.executeScript(function () {
      for (var i = 0; i < document.styleSheets.length; i++) {
        try {
          var rules = document.styleSheets[i].cssRules;
          for (var j = 0; j < rules.length; j++) {
            var t = rules[j].cssText || '';
            if (t.indexOf('prefers-reduced-motion') > -1 && t.indexOf('transform') > -1 && t.indexOf('none') > -1) {
              return true;
            }
          }
        } catch (e) { /* cross-origin */ }
      }
      return false;
    });
    assert(hasRule, 'expected a reduced-motion rule neutralizing transform in the loaded CSS');
  });

  // H4 — RU: actually render the page in Russian and assert no horizontal overflow / clip.
  // Note: the LONGEST description (employeesLeavesDescription, ~84 Cyrillic chars) is on the
  // SECOND card. The geometry check walks every .report-card-desc, so the long string is covered.
  it('RU locale (390px): long Cyrillic description wraps without overflow or clip', async function () {
    // Language switch is a GET to /language/<code> (see views/partials/header.hbs), then re-open /reports/.
    await open_page_func({ url: application_host + 'language/ru', driver: driver });
    await setViewport(driver, 390, 844);
    await openReports();
    await driver.sleep(300);

    var g = await driver.executeScript(function () {
      var de = document.documentElement;
      var descs = Array.prototype.slice.call(document.querySelectorAll('.report-card-desc'));
      var rights = descs.map(function (d) { return d.getBoundingClientRect().right; });
      var texts = descs.map(function (d) { return d.textContent; });
      var cards = document.querySelectorAll('.reports-hub .report-card');
      var a = cards[0] ? cards[0].getBoundingClientRect() : null;
      var b = cards[1] ? cards[1].getBoundingClientRect() : null;
      return {
        scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, innerWidth: window.innerWidth,
        descMaxRight: rights.length ? Math.max.apply(null, rights) : null,
        descTexts: texts,
        stacked: a && b ? Math.abs(a.left - b.left) < 1 : null,
        bBelowA: a && b ? b.top > a.top : null
      };
    });

    // Sanity: both Russian description strings actually rendered (not just JSON present).
    assert(g.descTexts.length === 2, 'RU: expected 2 card descriptions, got ' + g.descTexts.length);
    assert(g.descTexts.some(function (t) { return /Сравнение предоставленного/.test(t); }),
      'RU: allowance description did not render, got: ' + JSON.stringify(g.descTexts));
    assert(g.descTexts.some(function (t) { return /Просмотр отсутствий сотрудников/.test(t); }),
      'RU: long employeesLeaves description did not render, got: ' + JSON.stringify(g.descTexts));
    assert(g.stacked, 'RU mobile: cards should stack in one column');
    assert(g.bBelowA, 'RU mobile: second card below first');
    assert(g.scrollWidth <= g.clientWidth + 1,
      'RU: horizontal overflow scrollWidth=' + g.scrollWidth + ' > clientWidth=' + g.clientWidth);
    assert(g.scrollWidth <= g.innerWidth + 1,
      'RU: horizontal overflow scrollWidth=' + g.scrollWidth + ' > innerWidth=' + g.innerWidth);
    assert(g.descMaxRight !== null && g.descMaxRight <= g.innerWidth + 1,
      'RU: description right edge (' + g.descMaxRight + ') exceeds viewport (' + g.innerWidth + ')');

    await capture(driver, 'reports_390x844_ru');
  });

  // H4 — KK: render in Kazakh (Cyrillic, also long description) and assert no overflow / clip.
  it('KK locale (390px): long Cyrillic description wraps without overflow or clip', async function () {
    await open_page_func({ url: application_host + 'language/kk', driver: driver });
    await setViewport(driver, 390, 844);
    await openReports();
    await driver.sleep(300);

    var g = await driver.executeScript(function () {
      var de = document.documentElement;
      var descs = Array.prototype.slice.call(document.querySelectorAll('.report-card-desc'));
      var rights = descs.map(function (d) { return d.getBoundingClientRect().right; });
      var texts = descs.map(function (d) { return d.textContent; });
      var cards = document.querySelectorAll('.reports-hub .report-card');
      var a = cards[0] ? cards[0].getBoundingClientRect() : null;
      var b = cards[1] ? cards[1].getBoundingClientRect() : null;
      return {
        scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, innerWidth: window.innerWidth,
        descMaxRight: rights.length ? Math.max.apply(null, rights) : null,
        descTexts: texts,
        stacked: a && b ? Math.abs(a.left - b.left) < 1 : null,
        bBelowA: a && b ? b.top > a.top : null
      };
    });

    // Sanity: both Kazakh description strings actually rendered.
    assert(g.descTexts.length === 2, 'KK: expected 2 card descriptions, got ' + g.descTexts.length);
    assert(g.descTexts.some(function (t) { return /Таңдалған кезеңдегі берілген/.test(t); }),
      'KK: allowance description did not render, got: ' + JSON.stringify(g.descTexts));
    assert(g.descTexts.some(function (t) { return /Таңдалған кезеңдегі қызметкерлердің/.test(t); }),
      'KK: long employeesLeaves description did not render, got: ' + JSON.stringify(g.descTexts));
    assert(g.stacked, 'KK mobile: cards should stack in one column');
    assert(g.bBelowA, 'KK mobile: second card below first');
    assert(g.scrollWidth <= g.clientWidth + 1,
      'KK: horizontal overflow scrollWidth=' + g.scrollWidth + ' > clientWidth=' + g.clientWidth);
    assert(g.scrollWidth <= g.innerWidth + 1,
      'KK: horizontal overflow scrollWidth=' + g.scrollWidth + ' > innerWidth=' + g.innerWidth);
    assert(g.descMaxRight !== null && g.descMaxRight <= g.innerWidth + 1,
      'KK: description right edge (' + g.descMaxRight + ') exceeds viewport (' + g.innerWidth + ')');

    await capture(driver, 'reports_390x844_kk');
  });

  // Visual matrix: 6 states; default locale (en). Long-text (RU/KK) coverage is provided
  // by the dedicated RU/KK geometry tests above.
  it('captures the 6-state visual matrix (1440/1024/390 x light/dark)', async function () {
    // Ensure we are back on the default locale (en) for the matrix; language switch persists.
    await open_page_func({ url: application_host + 'language/en', driver: driver });
    await openReports();
    var states = [
      { w: 1440, h: 900, theme: 'light' },
      { w: 1024, h: 768, theme: 'light' },
      { w: 390, h: 844, theme: 'light' },
      { w: 1440, h: 900, theme: 'dark' },
      { w: 1024, h: 768, theme: 'dark' },
      { w: 390, h: 844, theme: 'dark' }
    ];
    for (var i = 0; i < states.length; i++) {
      var s = states[i];
      await setViewport(driver, s.w, s.h);
      await setTheme(driver, s.theme);
      await capture(driver, 'reports_' + s.w + 'x' + s.h + '_' + s.theme);
    }
  });
});
