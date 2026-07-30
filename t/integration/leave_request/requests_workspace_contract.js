'use strict';

/* globals describe, it, before, after */

/*
 * Stage 8D — Selenium contract: Requests workspace (/requests/).
 *
 * Covers the Stage 8D surface WITHOUT re-asserting the decision-safety behaviour
 * already locked by requests_decision_safety.js (selection, fixed bar geometry,
 * single-submit guard, AA contrast). This file asserts the NEW redesign contracts:
 *   - the two scoped areas render (.requests-approval.surface / .requests-history,
 *     year surfaces);
 *   - real Tab reaches a visible focus target; Space selection exposes the bulk bar;
 *   - pointer-down press-feedback is a non-identity transform under default media
 *     and is suppressed to none under CDP-emulated prefers-reduced-motion
 *     (incl. the :hover:active compound);
 *   - the exact POST endpoints are present (single approve/reject, bulk approve/
 *     reject, revoke, cancel);
 *   - the shared mobile geometry probe (text ranges + child boxes, four sides vs
 *     cell/card, horizontal vs viewport, scroll-vs-client on cell+card) for BOTH
 *     tables at 390px across default/RU/KK;
 *   - dark-theme AA contrast on .requests-section-heading;
 *   - the 6-state visual matrix + a bulk-bar screenshot.
 */

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const webdriver = require('selenium-webdriver');
const By = webdriver.By;
const until = webdriver.until;
const Key = webdriver.Key;
const moment = require('moment');
const config = require('../../lib/config');
const models = require('../../../lib/model/db');
const register_new_user_func = require('../../lib/register_new_user');
const add_new_user_func = require('../../lib/add_new_user');
const open_page_func = require('../../lib/open_page');

const SCREEN_DIR = '/tmp/screens';

function ensureScreenDir() {
  if (!fs.existsSync(SCREEN_DIR)) {
    fs.mkdirSync(SCREEN_DIR, { recursive: true });
  }
}

async function setViewport(driver, w, h) {
  await driver.manage().window().setRect({ width: w, height: h });
  await driver.sleep(250);
}

async function capture(driver, name) {
  ensureScreenDir();
  const image = await driver.takeScreenshot();
  const file = path.join(SCREEN_DIR, name + '.png');
  fs.writeFileSync(file, image, 'base64');
  assert(fs.statSync(file).size > 0, 'screenshot must be non-empty: ' + file);
  return file;
}

// Open the Bootstrap theme dropdown via its real toggle (the <a> inside #theme-menu).
// On collapsed navbars (mobile), expand .navbar-toggle first so the menu is interactable,
// then collapse it again afterwards for a clean screenshot.
async function setTheme(driver, theme /* 'light' | 'dark' */) {
  const navbarNeedsExpand = await driver.executeScript(
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

// Toggle prefers-reduced-motion via the Chrome DevTools Protocol.
async function setReducedMotion(driver, enabled /* true | false */) {
  await driver.sendDevToolsCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: enabled ? 'reduce' : '' }]
  });
  await driver.sleep(80);
}

async function openRequests(driver, application_host) {
  await open_page_func({ url: application_host + 'requests/', driver: driver });
  await driver.wait(until.elementLocated(By.css('.requests-page')), 2000);
}

// Shared mobile-geometry probe (Stage 8C canonical form). For EVERY cell of EVERY
// table on the page it measures text-node Range glyph boxes + descendant element
// boxes and asserts each rect stays within its CELL, its CARD, and the VIEWPORT
// (horizontal only — a requests page is tall and scrolls vertically) on the sides
// that matter, plus scroll-vs-client on each cell AND card (both axes) — the
// overflow:hidden clip signal.
const MOBILE_GEOMETRY_SCRIPT = function () {
  var de = document.documentElement;
  var TOL = 1;
  var SCROLL_TOL = 2;
  var tables = document.querySelectorAll('.mobile-card-table');
  var findings = [];
  var innerW = window.innerWidth;
  var innerH = window.innerHeight;
  var cellsChecked = 0;
  var textRanges = 0;
  var tablesFound = 0;

  function rnd(n) { return Math.round(n * 10) / 10; }
  function rec(kind, side, value, limit, where) {
    findings.push({ kind: kind, side: side, value: rnd(value), limit: rnd(limit), where: where });
  }
  // A node is visually hidden if it (or an ancestor) is sr-only / aria-hidden /
  // display:none / visibility:hidden / clipped-to-zero. Such content must NOT
  // generate geometry findings: Bootstrap .sr-only (white-space:nowrap inside a
  // 1px clipped box) makes Range.getClientRects() return many line-boxes that
  // mathematically spill past the cell even though nothing is visually overflowing.
  function isVisuallyHidden(node) {
    var el = node.nodeType === 3 ? node.parentElement : node;
    while (el && el !== td) {
      if (el.classList && el.classList.contains('sr-only')) return true;
      if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return true;
      el = el.parentElement;
    }
    return false;
  }
  function cellRects(td) {
    var out = [];
    var walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = walker.nextNode())) {
      if (!(n.nodeValue || '').trim()) continue;
      if (isVisuallyHidden(n)) continue;
      var rng = document.createRange();
      rng.selectNodeContents(n);
      var rs = rng.getClientRects();
      for (var i = 0; i < rs.length; i++) {
        if (rs[i].width <= 0 || rs[i].height <= 0) continue;
        out.push({ kind: 'text', l: rs[i].left, r: rs[i].right, t: rs[i].top, b: rs[i].bottom });
        textRanges++;
      }
    }
    var els = td.querySelectorAll('*');
    for (var j = 0; j < els.length; j++) {
      if (isVisuallyHidden(els[j])) continue;
      var b = els[j].getBoundingClientRect();
      if (b.width <= 0 || b.height <= 0) continue;
      out.push({ kind: 'el<' + els[j].tagName.toLowerCase() + '>', l: b.left, r: b.right, t: b.top, b: b.bottom });
    }
    return out;
  }
  function scrollGuard(el, where) {
    if (el.scrollWidth > el.clientWidth + SCROLL_TOL) rec('scroll', 'scrollW>clientW', el.scrollWidth, el.clientWidth, where);
    if (el.scrollHeight > el.clientHeight + SCROLL_TOL) rec('scroll', 'scrollH>clientH', el.scrollHeight, el.clientHeight, where);
  }

  var diagnostics = null;

  for (var ti = 0; ti < tables.length; ti++) {
    var table = tables[ti];
    tablesFound++;
    var rows = table.querySelectorAll('tbody > tr');
    for (var ri = 0; ri < rows.length; ri++) {
      var card = rows[ri].getBoundingClientRect();
      scrollGuard(rows[ri], 'table' + ti + '.row' + ri);
      var tds = rows[ri].querySelectorAll('td[data-label]');
      for (var ci = 0; ci < tds.length; ci++) {
        var td = tds[ci];
        cellsChecked++;
        var cell = td.getBoundingClientRect();
        var where0 = 'table' + ti + '.row' + ri + '.cell#' + ci;
        scrollGuard(td, where0);
        var rs = cellRects(td);
        for (var k = 0; k < rs.length; k++) {
          var r = rs[k];
          var where = where0 + '.' + r.kind;
          if (r.l < cell.left - TOL) rec(r.kind, 'left<cell', r.l, cell.left, where);
          if (r.r > cell.right + TOL) rec(r.kind, 'right>cell', r.r, cell.right, where);
          if (r.t < cell.top - TOL) rec(r.kind, 'top<cell', r.t, cell.top, where);
          if (r.b > cell.bottom + TOL) {
            rec(r.kind, 'bottom>cell', r.b, cell.bottom, where);
            // capture diagnostics on the first bottom>cell violation to understand the layout
            if (!diagnostics) {
              var belowEls = [];
              var allEls = td.querySelectorAll('*');
              for (var e = 0; e < allEls.length && belowEls.length < 4; e++) {
                var eb = allEls[e].getBoundingClientRect();
                if (eb.height <= 0) continue;
                if (eb.bottom > cell.bottom + TOL) {
                  var ecs = getComputedStyle(allEls[e]);
                  belowEls.push({
                    tag: allEls[e].tagName,
                    cls: String(allEls[e].className || '').slice(0, 60),
                    bottom: Math.round(eb.bottom), cellBottom: Math.round(cell.bottom),
                    display: ecs.display, position: ecs.position, visibility: ecs.visibility,
                    offsetH: allEls[e].offsetHeight
                  });
                }
              }
              diagnostics = {
                where: where0,
                label: td.getAttribute('data-label'),
                cellBottom: Math.round(cell.bottom),
                innerHTML: td.innerHTML.replace(/\s+/g, ' ').slice(0, 240),
                belowEls: belowEls
              };
            }
          }
          if (r.l < card.left - TOL) rec(r.kind, 'left<card', r.l, card.left, where);
          if (r.r > card.right + TOL) rec(r.kind, 'right>card', r.r, card.right, where);
          if (r.t < card.top - TOL) rec(r.kind, 'top<card', r.t, card.top, where);
          if (r.b > card.bottom + TOL) rec(r.kind, 'bottom>card', r.b, card.bottom, where);
          if (r.l < -TOL) rec(r.kind, 'left<viewport', r.l, 0, where);
          if (r.r > innerW + TOL) rec(r.kind, 'right>viewport', r.r, innerW, where);
        }
      }
    }
  }

  return {
    tablesFound: tablesFound,
    cellsChecked: cellsChecked,
    textRanges: textRanges,
    scrollWidth: de.scrollWidth,
    clientWidth: de.clientWidth,
    innerWidth: innerW,
    innerHeight: innerH,
    findings: findings,
    diagnostics: diagnostics
  };
};

async function assertMobileGeometry(driver, locale) {
  await driver.sleep(300);
  const g = await driver.executeScript(MOBILE_GEOMETRY_SCRIPT);
  const L = locale ? '[' + locale + '] ' : '';
  assert(g.tablesFound >= 1, L + 'expected >=1 mobile-card-table, got ' + g.tablesFound);
  assert(g.cellsChecked > 0, L + 'no td[data-label] cells found');
  assert(g.textRanges > 0, L + 'no text-node ranges measured — probe is degenerate');
  assert(g.scrollWidth <= g.clientWidth + 1,
    L + 'horizontal overflow: scrollWidth=' + g.scrollWidth + ' > clientWidth=' + g.clientWidth);
  assert(g.scrollWidth <= g.innerWidth + 1,
    L + 'horizontal overflow: scrollWidth=' + g.scrollWidth + ' > innerWidth=' + g.innerWidth);
  assert(g.findings.length === 0,
    L + 'mobile geometry violations (' + g.findings.length + '): ' +
    JSON.stringify(g.findings.slice(0, 12)) +
    (g.diagnostics ? '\nDIAGNOSTICS: ' + JSON.stringify(g.diagnostics) : ''));
  return g;
}

describe('Requests workspace interaction, geometry & visual matrix (Stage 8D)', function () {

  this.timeout(config.get_execution_timeout());

  var driver;
  var application_host = config.get_application_host();
  var employeeEmail = 'requests-8d-' + (new Date()).getTime() + '@test.com';
  var admin;
  var employee;
  var leaveType;
  var leaveStart;

  before(function (done) {
    register_new_user_func({ application_host: application_host }).then(async function (data) {
      driver = data.driver;
      await add_new_user_func({
        application_host: application_host,
        driver: driver,
        email: employeeEmail
      });
      admin = await models.User.findOne({ where: { email: data.email } });
      employee = await models.User.findOne({ where: { email: employeeEmail } });
      await employee.update({ name: 'Ada', lastname: 'Lovelace' });
      await employee.reload();
      leaveType = await models.LeaveType.findOne({ where: { companyId: admin.companyId } });
      leaveStart = moment.utc().add(40, 'days').startOf('day');

      // Two pending leaves FROM the employee (populate the approval table) — pattern
      // from requests_decision_safety.js: create directly via the model so the test is
      // independent of the book-leave UI.
      for (var i = 0; i < 2; i++) {
        var start = leaveStart.clone().add(i * 7, 'days');
        await models.Leave.create({
          userId: employee.id,
          approverId: null,
          leaveTypeId: leaveType.id,
          status: models.Leave.status_new(),
          date_start: start.format('YYYY-MM-DD'),
          date_end: start.clone().add(2, 'days').format('YYYY-MM-DD')
        });
      }
      // One APPROVED leave owned by the admin (populate the absence history with a
      // revoke action) so the history table + status chip render non-vacuously.
      var histStart = leaveStart.clone().subtract(20, 'days');
      await models.Leave.create({
        userId: admin.id,
        approverId: admin.id,
        leaveTypeId: leaveType.id,
        status: models.Leave.status_approved(),
        date_start: histStart.format('YYYY-MM-DD'),
        date_end: histStart.clone().add(1, 'days').format('YYYY-MM-DD')
      });
      done();
    }, done);
  });

  after(function () {
    return driver.quit();
  });

  it('renders the scoped two-area workspace', async function () {
    await openRequests(driver, application_host);
    await driver.findElement(By.css('.requests-page'));
    await driver.findElement(By.css('.requests-approval.surface'));
    await driver.findElement(By.css('.requests-history'));
    // year surface + heading from the history
    await driver.findElement(By.css('.requests-year-surface.surface'));
    await driver.findElement(By.css('.requests-year-heading'));
    // both locked section headings
    var headings = await driver.findElements(By.css('main h2.requests-section-heading'));
    assert.strictEqual(headings.length, 2, 'expected 2 .requests-section-heading');
  });

  it('history table is a scoped mobile-card table with status chips', async function () {
    await openRequests(driver, application_host);
    var histTable = await driver.findElement(By.css('.user-requests-table.requests-history-table'));
    assert(histTable, 'history table missing requests-history-table/mobile-card classes');
    var chips = await driver.findElements(By.css('.requests-history .request-status-chip'));
    assert(chips.length > 0, 'expected >=1 status chip in the history');
    // the admin's approved leave yields an approved chip
    var approved = await driver.findElements(By.css('.request-status-chip.request-status--approved'));
    assert(approved.length > 0, 'expected an approved status chip (admin approved leave)');
  });

  // Real Tab reaches a visible, focusable control (not a JS .focus() shortcut).
  it('real Tab reaches a visible focusable control', async function () {
    await setViewport(driver, 1024, 768);
    await openRequests(driver, application_host);
    await driver.executeScript('document.body.focus();');
    await driver.sleep(120);
    var reached = false;
    var sequence = [];
    for (var i = 0; i < 30; i++) {
      await driver.actions().sendKeys(Key.TAB).perform();
      await driver.sleep(40);
      var info = await driver.executeScript(function () {
        var el = document.activeElement;
        if (!el) return null;
        return {
          tag: el.tagName,
          type: el.getAttribute('type') || '',
          cls: String(el.className || ''),
          visible: !!(el.offsetWidth > 0 || el.offsetHeight > 0)
        };
      });
      if (!info) { sequence.push('(none)'); continue; }
      sequence.push(info.tag + (info.type ? '[' + info.type + ']' : ''));
      // a visible, focusable interactive element proves the Tab loop works
      if (info.visible && (info.tag === 'A' || info.tag === 'BUTTON' ||
          (info.tag === 'INPUT' && (info.type === 'checkbox' || info.type === 'submit')))) {
        reached = true;
        break;
      }
    }
    assert(reached, 'Tab loop never reached a visible interactive control. Sequence: ' + sequence.join(' -> '));
  });

  // Space selects a row and exposes the controller-driven bulk bar.
  it('Space selects a row and exposes the bulk bar', async function () {
    await setViewport(driver, 1024, 768);
    await openRequests(driver, application_host);
    var checkbox = await driver.findElement(By.css('.bulk-request-checkbox'));
    await checkbox.sendKeys(Key.SPACE);
    await driver.wait(function () {
      return driver.executeScript('return arguments[0].checked', checkbox);
    }, 2000);
    var state = await driver.executeScript(function () {
      var form = document.getElementById('bulk-action-form');
      var cs = form ? getComputedStyle(form) : null;
      var count = document.querySelector('.bulk-selected-count');
      return {
        hidden: form ? form.hidden : 'no-form',
        position: cs ? cs.position : null,
        countText: count ? count.textContent : ''
      };
    });
    assert.strictEqual(state.hidden, false, 'bulk bar should be visible after selection');
    assert.strictEqual(state.position, 'fixed', 'bulk bar should be position:fixed');
    assert(/1/.test(state.countText), 'selected count should mention 1, got "' + state.countText + '"');
  });

  // POST endpoints present in the rendered markup (single + bulk + revoke + cancel).
  it('exposes the exact POST endpoints for every operation', async function () {
    await openRequests(driver, application_host);
    var src = await driver.executeScript('return document.documentElement.outerHTML');
    assert(src.indexOf('action="/requests/approve/"') > -1, 'missing single approve endpoint');
    assert(src.indexOf('action="/requests/reject/"') > -1, 'missing single reject endpoint');
    assert(src.indexOf('formaction="/requests/bulk/approve/"') > -1, 'missing bulk approve endpoint');
    assert(src.indexOf('formaction="/requests/bulk/reject/"') > -1, 'missing bulk reject endpoint');
    assert(src.indexOf('action="/requests/revoke/"') > -1, 'missing revoke endpoint');
    // cancel endpoint (only present for the employee\'s own pending leave; the admin
    // approved leave yields revoke). Assert the route exists in the controller source
    // rather than the DOM to avoid depending on which rows render cancel.
    var routeSrc = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'lib', 'route', 'requests.js'), 'utf8');
    assert(routeSrc.indexOf("'/cancel/'") > -1, 'cancel route not registered in controller');
  });

  // Press-feedback: pointer-down yields a non-identity transform under default media.
  it('pointer-down press yields a non-identity transform on an approve button', async function () {
    await setViewport(driver, 1024, 768);
    await openRequests(driver, application_host);
    var approve = await driver.wait(
      until.elementLocated(By.css('.requests-to-approve-table input.btn-success')),
      3000
    );
    // A neutral, non-interactive element to release the pointer on so the press never
    // fires a click on the submit button (which would actually approve the leave and
    // consume the pending row, starving later tests).
    var neutral = await driver.findElement(By.css('.page-heading h1'));
    var actions = driver.actions({ async: true });
    await actions.move({ origin: approve }).press().perform();
    await driver.sleep(150);
    var baseline = await driver.executeScript(
      'var el=arguments[0]; return {transform:getComputedStyle(el).transform, active:el.matches(":active")};',
      approve
    );
    await driver.actions({ async: true }).move({ origin: neutral }).release().perform();
    assert(baseline.active, 'precondition: approve button should be :active under press');
    assert(baseline.transform !== 'none' && baseline.transform !== 'matrix(1, 0, 0, 1, 0, 0)',
      'baseline: active approve button should have a non-identity transform, got ' + baseline.transform);
  });

  // Reduced-motion via CDP suppresses the active transform to none (incl. :hover:active).
  it('reduced-motion (CDP): emulated media suppresses the active transform to none', async function () {
    await setViewport(driver, 1024, 768);
    await openRequests(driver, application_host);
    await setReducedMotion(driver, true);
    var mqApplied = await driver.executeScript(
      'return window.matchMedia("(prefers-reduced-motion: reduce)").matches'
    );
    assert(mqApplied, 'CDP Emulation.setEmulatedMedia(reduce) did not apply');

    // Re-open under the emulated media for a stable DOM, then press an approve button.
    await openRequests(driver, application_host);
    var approve = await driver.wait(
      until.elementLocated(By.css('.requests-to-approve-table input.btn-success')),
      3000
    );
    var neutral = await driver.findElement(By.css('.page-heading h1'));
    var actions = driver.actions({ async: true });
    await actions.move({ origin: approve }).press().perform();
    await driver.sleep(150);
    var underRM = await driver.executeScript(
      'var el=arguments[0]; return {transform:getComputedStyle(el).transform, active:el.matches(":active")};',
      approve
    );
    // Release on the neutral heading so the click never submits the approve form.
    await driver.actions({ async: true }).move({ origin: neutral }).release().perform();
    assert(underRM.active, 'precondition under RM: approve button should be :active under press');
    assert.strictEqual(underRM.transform, 'none',
      'reduced-motion: active transform must be suppressed to "none", got ' + underRM.transform);

    await setReducedMotion(driver, false);
    var mqCleared = await driver.executeScript(
      'return window.matchMedia("(prefers-reduced-motion: reduce)").matches'
    );
    assert(!mqCleared, 'CDP reset did not clear prefers-reduced-motion');
  });

  // Dark-theme AA contrast on .requests-section-heading (>=4.5), per decision-safety.
  it('dark theme: section-heading contrast meets WCAG AA (>=4.5)', async function () {
    await setViewport(driver, 1024, 768);
    await openRequests(driver, application_host);
    await setTheme(driver, 'dark');
    var cr = await driver.executeScript(function () {
      function lum(c) {
        var m = c.match(/\d+/g);
        if (!m) return 0;
        var rs = m.map(function (v) { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
        return 0.2126 * rs[0] + 0.7152 * rs[1] + 0.0722 * rs[2];
      }
      var h = document.querySelector('.requests-section-heading');
      var cs = getComputedStyle(h);
      var bodyCs = getComputedStyle(document.body);
      var l1 = lum(cs.color), l2 = lum(bodyCs.backgroundColor);
      var ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      return { ratio: Math.round(ratio * 100) / 100, color: cs.color, bg: bodyCs.backgroundColor };
    });
    assert(cr.ratio >= 4.5,
      '.requests-section-heading dark contrast ' + cr.ratio + ' < 4.5 (color=' + cr.color + ' bg=' + cr.bg + ')');
  });

  it('mobile (390px): all cell text ranges + child boxes within cell/card/viewport; no scroll overflow', async function () {
    await setViewport(driver, 390, 844);
    await openRequests(driver, application_host);
    await assertMobileGeometry(driver, null);
  });

  it('RU locale (390px): labels + chips wrap without overflow or clip', async function () {
    await open_page_func({ url: application_host + 'language/ru', driver: driver });
    await setViewport(driver, 390, 844);
    await openRequests(driver, application_host);
    await assertMobileGeometry(driver, 'RU');
    await capture(driver, 'requests_390x844_ru');
  });

  it('KK locale (390px): labels + chips wrap without overflow or clip', async function () {
    await open_page_func({ url: application_host + 'language/kk', driver: driver });
    await setViewport(driver, 390, 844);
    await openRequests(driver, application_host);
    await assertMobileGeometry(driver, 'KK');
    await capture(driver, 'requests_390x844_kk');
  });

  it('captures the 6-state visual matrix (1440/1024/390 x light/dark)', async function () {
    await open_page_func({ url: application_host + 'language/en', driver: driver });
    await openRequests(driver, application_host);
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
      await openRequests(driver, application_host);
      await driver.sleep(150);
      await capture(driver, 'requests_' + s.w + 'x' + s.h + '_' + s.theme);
    }
  });

  // Dedicated screenshot: selected rows + open bulk bar (the controller-driven state).
  it('screenshot: selected rows with the bulk bar open', async function () {
    await open_page_func({ url: application_host + 'language/en', driver: driver });
    await setViewport(driver, 390, 844);
    await setTheme(driver, 'light');
    await openRequests(driver, application_host);
    var checkboxes = await driver.wait(
      until.elementsLocated(By.css('.bulk-request-checkbox')), 3000
    );
    assert(checkboxes.length > 0, 'expected >=1 selectable pending row for the bulk-bar screenshot');
    for (var i = 0; i < checkboxes.length; i++) {
      var cbs = await driver.findElements(By.css('.bulk-request-checkbox'));
      if (i < cbs.length) {
        await cbs[i].sendKeys(Key.SPACE);
        await driver.sleep(120);
      }
    }
    await driver.wait(function () {
      return driver.executeScript(
        'var f=document.getElementById("bulk-action-form"); return !!(f && !f.hidden);'
      );
    }, 2000);
    await driver.sleep(300);
    await capture(driver, 'requests_390x844_bulkbar');
  });
});
