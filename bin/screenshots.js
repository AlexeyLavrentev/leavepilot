#!/usr/bin/env node

'use strict';

/*
  README screenshot generator (plan 06-04, INSTALL-04; D-13/D-14/D-15/D-21).

  `npm run screenshots` produces the two images the README embeds:

    1. stand  - unless BASE_URL points at an already-running stand, run
                bin/demo.js first (the 06-03 one-command stand: reset, up,
                HTTP wait, seed «Демо компания» with the fixed demo admin);
    2. login  - drive the real login form with the fixed demo credentials
                (D-12) - the honest copy of what a stranger does, not a
                hand-rolled POST;
    3. shoot  - the team calendar (/calendar/teamview/) and the requests
                list (/requests/) at a 1440x900 desktop viewport, written
                to docs/screenshots/ for the README's relative embeds.

  The interface must render Russian (D-14). The spec infrastructure pins
  the browser language to English (t/lib/build_driver.js) because browser
  specs assert English strings; this script deliberately pins the OPPOSITE
  - a ru browser lang
  plus the i18next=ru cookie, which wins the app's detection order
  (querystring, cookie, header) whatever Accept-Language the host's
  browser build would send. The <html lang> attribute is asserted at
  runtime, so an English render fails the run instead of shipping an
  English screenshot to a Russian README.

  Works against any live stand (D-21): pre-tag the locally built image
  that bin/demo.js raises, post-tag the GHCR image under the same compose,
  or any other stand via BASE_URL.

  Browser handling follows t/lib/build_driver.js: CHROME_BIN wins over the
  puppeteer-downloaded Chrome, and the headless args are the same
  (--headless=new, --disable-gpu, --no-sandbox, --disable-dev-shm-usage,
  --hide-scrollbars) minus the English language pin. The viewport follows
  t/lib/set_viewport.js: ask, measure window.innerWidth/innerHeight,
  throw if the page did not get what was asked.

  The stand is deliberately left running at the end - the teardown command
  is printed instead.
*/

const log = require('../lib/middleware/request_logger');

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'docs', 'screenshots');

// The same single port lever bin/demo.js and docker-compose.demo.yml expose.
const DEMO_PORT = String(process.env.DEMO_PORT || '3001').trim();

// The fixed demo credentials the wrapper prints (D-12; T-06-06 accepted:
// throwaway local stand, deliberately non-secret).
const ADMIN_EMAIL = 'demo-admin@leavepilot.local';
const ADMIN_PASSWORD = 'DemoLeavePilot1!';

const VIEWPORT_WIDTH = 1440;
const VIEWPORT_HEIGHT = 900;

// t/lib/build_driver.js headless args verbatim, minus the language pin.
const HEADLESS_ARGS = [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--hide-scrollbars',
];

// RU interface (D-14): the browser's own UI chrome, plus the cookie the
// app's language detection honours before any Accept-Language header.
const LANGUAGE = 'ru';

const TEARDOWN_COMMAND = 'docker compose -f docker-compose.demo.yml down -v';

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

/*
  Anonymous GET on the site root: resolves the status string ('302', ...),
  or null when the stand does not answer yet. Native http keeps this script
  free of any external binary (bin/demo.js uses the same shape).
*/
function httpStatus(url) {
  return new Promise(resolve => {
    const request = http.get(url, response => {
      response.resume();
      resolve(String(response.statusCode));
    });
    request.setTimeout(5000, () => {
      request.destroy();
      resolve(null);
    });
    request.on('error', () => resolve(null));
  });
}

async function waitForStand(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;

  for (;;) {
    last = await httpStatus(`${baseUrl}/`);
    if (last === '302') {
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `стенд на ${baseUrl} не отвечает 302 на / (последний ответ: ${last}).`
        + (process.env.BASE_URL ? ' Поднимите его, например `npm run demo`, и повторите.' : '')
      );
    }

    await sleep(1000);
  }
}

/*
  The stand contract (06-03): by default raise it via bin/demo.js - reset,
  up, HTTP wait and seed are that wrapper's job, so this script never
  reimplements them. BASE_URL opts out and shoots an already-running stand
  instead (D-21: the same script works pre-tag on the local image and
  post-tag on GHCR, or against any other deployment being documented).
*/
async function ensureStand() {
  if (process.env.BASE_URL) {
    const baseUrl = String(process.env.BASE_URL).replace(/\/+$/, '');

    log.info(`Используем уже поднятый стенд: ${baseUrl}`);
    // Short budget: an already-running stand answers at once; this poll
    // only guards against a typo'd URL.
    await waitForStand(baseUrl, 30 * 1000);

    return baseUrl;
  }

  log.info('Поднимаем демо-стенд (bin/demo.js: сброс, запуск, ожидание, демо-данные)...');

  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'demo.js')], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', reject);
    child.on('exit', exitCode => resolve(exitCode === null ? 1 : exitCode));
  });

  if (code !== 0) {
    throw new Error('bin/demo.js завершился с кодом ' + code + ' - стенд не поднят.');
  }

  const baseUrl = `http://localhost:${DEMO_PORT}`;

  // bin/demo.js already waited for the 302; this re-check is a cheap safety
  // net between the two processes.
  await waitForStand(baseUrl, 30 * 1000);

  return baseUrl;
}

/*
  Ask for the viewport, then measure what the page actually got
  (t/lib/set_viewport.js discipline). Puppeteer's setViewport sets the
  layout viewport directly, so a mismatch here means something fought the
  request - and a screenshot taken at a viewport it did not ask for is
  worse than a failing run.
*/
async function assertViewport(page) {
  const measured = await page.evaluate(
    () => ({ width: window.innerWidth, height: window.innerHeight }) // eslint-disable-line no-undef
  );

  if (measured.width !== VIEWPORT_WIDTH || measured.height !== VIEWPORT_HEIGHT) {
    throw new Error(
      `страница получила вьюпорт ${measured.width}x${measured.height}`
      + ` вместо запрошенного ${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}.`
    );
  }
}

async function login(page, baseUrl) {
  await page.goto(`${baseUrl}/login/`, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('#local_login_form', { timeout: 15000 });

  await page.type('#local_login_form input[name="email"]', ADMIN_EMAIL);
  await page.type('#local_login_form input[name="password"]', ADMIN_PASSWORD);

  // A successful login lands on the calendar (the dashboard route redirects
  // / to ./calendar/ for authenticated users).
  await Promise.all([
    page.waitForFunction(
      () => window.location.pathname.indexOf('/calendar') === 0, // eslint-disable-line no-undef
      { timeout: 60000 }
    ),
    page.click('#submit_login'),
  ]);
}

/*
  Load a page, prove it rendered in the right language (D-14) and take the
  viewport screenshot. Viewport-only on purpose: the README embeds a
  desktop-sized picture (exactly 1440x900), not a scroll-length strip.
*/
async function shootPage(page, url, contentSelector, outputFile) {
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector(contentSelector, { timeout: 15000 });

  const renderedLang = await page.evaluate(() => document.documentElement.lang); // eslint-disable-line no-undef
  if (renderedLang !== LANGUAGE) {
    throw new Error(
      `интерфейс отрисовался на «${renderedLang}», ожидается «${LANGUAGE}» (D-14).`
    );
  }

  // Let bootstrap/fontawesome settle after network idle so the capture is
  // not mid-animation.
  await sleep(400);

  await page.screenshot({ path: outputFile });

  const relativePath = path.relative(ROOT, outputFile);
  const kilobytes = Math.round(fs.statSync(outputFile).size / 1024);
  log.info(`  ${relativePath} (${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}, ${kilobytes} КБ)`);
}

(async () => {
  let step = 'подъём демо-стенда';

  try {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    const baseUrl = await ensureStand();

    step = 'запуск браузера';
    log.info(`Запускаем браузер (viewport ${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT})...`);

    const browser = await puppeteer.launch({
      headless: true,
      // CHROME_BIN first (t/lib/build_driver.js resolution order); otherwise
      // puppeteer launches the Chrome it downloaded itself.
      executablePath: process.env.CHROME_BIN || undefined,
      defaultViewport: {
        width: VIEWPORT_WIDTH,
        height: VIEWPORT_HEIGHT,
        deviceScaleFactor: 1,
      },
      args: HEADLESS_ARGS.concat(`--lang=${LANGUAGE}`),
    });

    try {
      const page = await browser.newPage();

      // Pin the application language server-side: the i18next cookie wins
      // the detection order (querystring, cookie, header) before any
      // Accept-Language the host browser build would send.
      await page.setCookie({ name: 'i18next', value: LANGUAGE, url: baseUrl });

      step = 'проверка вьюпорта';
      await assertViewport(page);

      step = 'вход по форме логина';
      log.info(`Входим как демо-администратор (${ADMIN_EMAIL})...`);
      await login(page, baseUrl);

      step = 'календарь команды';
      log.info('Снимаем экраны:');
      await shootPage(
        page,
        `${baseUrl}/calendar/teamview/`,
        '.team-view-page',
        path.join(OUTPUT_DIR, 'calendar.png')
      );

      step = 'список заявок';
      await shootPage(
        page,
        `${baseUrl}/requests/`,
        '.requests-page',
        path.join(OUTPUT_DIR, 'requests.png')
      );
    } finally {
      await browser.close();
    }

    log.info('');
    log.info('Готово! Скриншоты лежат в docs/screenshots/ и уже встроены в README.');
    log.info('');
    log.info('  Демо-стенд оставлен запущенным: ' + baseUrl);
    log.info('  Убрать стенд:  ' + TEARDOWN_COMMAND);
    log.info('');
  } catch (error) {
    log.error('');
    log.error(
      'Не удалось снять скриншоты (шаг «' + step + '»): '
      + ((error && error.message) || error)
    );
    process.exit(1);
  }
})();
