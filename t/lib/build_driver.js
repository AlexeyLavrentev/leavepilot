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
  }

  return new webdriver.Builder()
    .forBrowser('chrome')
    .setChromeOptions(options)
    .build();
};
