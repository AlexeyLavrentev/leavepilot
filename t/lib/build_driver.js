// Generous: a healthy quit takes milliseconds.
var QUIT_TIMEOUT_MS = 15000;

/*
  Wraps a quit so it always settles.

  Teardown has no assertion to make, so the only thing that matters is that it
  finishes. Left unbounded it does not: fifty-three specs tear down with
  `after(done => driver.quit().then(done))` and no catch, so a quit that rejects
  never calls done(), and one that hangs on a socket to a browser that has
  already gone never calls it either. The suite can then neither continue nor
  end, and the run goes silent until something outside kills it - which is what
  both hangs captured on CI look like, each beginning on the line right after
  mocha printed a failing test.
*/
function boundQuit(quit, timeoutMs) {
  return function() {
    return new Promise(function(resolve) {
      var settled = false;

      var finish = function(note) {
        if (settled) return;
        settled = true;
        if (note) console.error(note);
        resolve();
      };

      var timer = setTimeout(function() {
        finish('driver.quit did not return within ' + timeoutMs + 'ms, carrying on');
      }, timeoutMs);

      // unref, so the teardown timer cannot itself keep the process alive.
      if (typeof timer.unref === 'function') timer.unref();

      Promise.resolve()
        .then(quit)
        .then(
          function() { clearTimeout(timer); finish(); },
          function(error) {
            clearTimeout(timer);
            finish('driver.quit failed, carrying on: ' + (error && error.message));
          }
        );
    });
  };
}


var fs = require('fs'),
    path = require('path'),
    os = require('os'),
    webdriver = require('selenium-webdriver'),
    chrome = require('selenium-webdriver/chrome'),
    puppeteer = require('puppeteer');

function findCachedChromeHeadlessShell() {
  var cacheDir = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome-headless-shell');

  if (!fs.existsSync(cacheDir)) {
    return null;
  }

  var pending = [cacheDir];

  while (pending.length) {
    var current = pending.pop();
    var stats = fs.statSync(current);

    if (stats.isFile() && path.basename(current) === 'chrome-headless-shell') {
      return current;
    }

    if (stats.isDirectory()) {
      fs.readdirSync(current).forEach(function(child) {
        pending.push(path.join(current, child));
      });
    }
  }

  return null;
}

/*
  Where puppeteer put the browser it downloaded.

  puppeteer.executablePath() used to answer this and now returns a promise, and
  this function has to stay synchronous - fifty-odd specs build a driver from
  it, none of them able to await. The promise did not announce itself either:
  fs.existsSync of one returns false rather than throwing, so the branch simply
  stopped finding anything and resolution fell through to the headless shell,
  which is a different binary from the Chrome these specs are written against.

  The path is computed instead, from the build id puppeteer pins and the cache
  layout it uses - both of which it exposes synchronously.
*/
function findDownloadedChrome() {
  try {
    var revisions = require('puppeteer-core').PUPPETEER_REVISIONS;
    var computeExecutablePath = require('@puppeteer/browsers').computeExecutablePath;

    return computeExecutablePath({
      browser: 'chrome',
      buildId: revisions.chrome,
      cacheDir: path.join(os.homedir(), '.cache', 'puppeteer'),
    });
  } catch (error) {
    return null;
  }
}

function resolveChromeBinary() {
  if (process.env.CHROME_BIN) {
    return process.env.CHROME_BIN;
  }

  var downloaded = findDownloadedChrome();
  if (downloaded && fs.existsSync(downloaded)) {
    return downloaded;
  }

  return findCachedChromeHeadlessShell();
}

/*
  Separated from the driver so what Chrome is told can be asserted without
  starting one.
*/
function buildOptions() {
  var options = new chrome.Options();
  var chromeBinary = resolveChromeBinary();

  if (chromeBinary) {
    options.setChromeBinaryPath(chromeBinary);
  }

  /*
    The suite asserts English strings, so the browser's language is part of the
    contract these specs are written against rather than something to inherit
    from whoever runs them. CI's Chrome happens to negotiate English; a
    developer's may not. On a machine whose Chrome asks for Russian the
    registration page comes back "Новая компания" and every browser spec fails
    at its first assertion - which reads as the whole suite being broken locally
    rather than as a language mismatch.

    Both halves are needed: --lang sets the UI language, the preference sets the
    Accept-Language header, and it is the header the application negotiates on.

    Outside the headless block, because the language is not a headless concern.
  */
  options.addArguments('--lang=en-US');
  options.setUserPreferences({'intl.accept_languages': 'en-US,en'});

  if (!process.env.SHOW_CHROME) {
    options.addArguments('--headless=new');
    options.addArguments('--disable-gpu');
    options.addArguments('--no-sandbox');
    options.addArguments('--disable-dev-shm-usage');
    /*
      Linux draws a classic 15px scrollbar that eats layout width, macOS draws an
      overlay one that does not. Geometry contracts written against the latter
      then measure 15px short on CI. Phones — which the 390px viewport in those
      contracts emulates — use overlay scrollbars too, so hiding the bar here
      measures the layout rather than the host's window chrome.
    */
    options.addArguments('--hide-scrollbars');
    /*
      Headless reports no hover-capable pointer, so every `@media (hover: hover)`
      rule is inert and hover styling cannot be tested at all — a contract that
      measures a hover elevation then fails however real the synthetic pointer
      is. Present the desktop pointer these contracts describe.
    */
    options.addArguments(
      '--blink-settings=primaryHoverType=2,availableHoverTypes=2,'
      + 'primaryPointerType=4,availablePointerTypes=4'
    );
  }

  return options;
}

module.exports = function() {
  var driver = new webdriver.Builder()
    .forBrowser('chrome')
    .setChromeOptions(buildOptions())
    .build();

  /*
    ChromeDriver defaults to a five-minute page-load timeout, which is longer
    than the budget any spec here gets. A submit whose response never arrives
    therefore leaves the WebDriver command pending: mocha gives up first and
    reports a bare timeout, the promise never settles, and even a chain ending
    in .catch(done) has nothing to catch. Failing inside the spec's own budget
    turns that into an error that names the page it was loading.
  */
  driver.manage().setTimeouts({
    implicit: 0,
    pageLoad: 30000,
    script: 20000,
  });

  /*
    quit() is bounded, because an unbounded one is how this suite hangs.

    Fifty-three specs tear down with `after(done => driver.quit().then(done))`
    and no catch. When the browser is already gone - which is what a wedged spec
    leaves behind - that request can sit on a socket indefinitely: done() is
    never called, the suite can neither continue nor end, and the run goes
    silent until something outside kills it. Both hangs captured on CI begin on
    the line immediately after mocha printed a failing test, which is exactly
    where this hook runs.

    Teardown has no assertion to make, so it resolves either way. A browser that
    outlives the process is the CI runner's problem to reap, and it already
    does; a suite that cannot finish is nobody's.
  */
  driver.quit = boundQuit(driver.quit.bind(driver), QUIT_TIMEOUT_MS);

  return driver;
};

module.exports.boundQuit = boundQuit;
module.exports.buildOptions = buildOptions;
