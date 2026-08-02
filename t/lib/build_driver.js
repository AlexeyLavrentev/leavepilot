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

function resolveChromeBinary() {
  if (process.env.CHROME_BIN) {
    return process.env.CHROME_BIN;
  }

  var puppeteerBinary = puppeteer.executablePath();
  if (puppeteerBinary && fs.existsSync(puppeteerBinary)) {
    return puppeteerBinary;
  }

  return findCachedChromeHeadlessShell();
}

module.exports = function() {
  var options = new chrome.Options();
  var chromeBinary = resolveChromeBinary();

  if (chromeBinary) {
    options.setChromeBinaryPath(chromeBinary);
  }

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

  var driver = new webdriver.Builder()
    .forBrowser('chrome')
    .setChromeOptions(options)
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

  return driver;
};
