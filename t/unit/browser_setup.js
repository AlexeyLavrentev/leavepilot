'use strict';

const expect = require('chai').expect;
const path = require('path');
const setup = require('../../bin/browser_setup');

describe('browser setup', function() {
  const cacheRoot = path.join(process.cwd(), '.artifacts', 'verify', 'browser');

  it('keeps resolved executable paths below the repository cache root', function() {
    expect(setup.isWithinCache(cacheRoot, path.join(cacheRoot, 'chrome', 'chrome'))).to.equal(true);
    expect(setup.isWithinCache(cacheRoot, path.join(cacheRoot, '..', 'outside'))).to.equal(false);
  });

  it('requires matching browser and driver major versions', function() {
    expect(setup.haveMatchingMajorVersions('151.0.7922.47', '151.0.7922.47')).to.equal(true);
    expect(setup.haveMatchingMajorVersions('151.0.7922.47', '150.0.1.1')).to.equal(false);
    expect(setup.haveMatchingMajorVersions('not-a-version', '151.0.1.1')).to.equal(false);
  });

  it('names the bounded bootstrap command when the cache is missing', function() {
    expect(setup.missingPrerequisiteMessage()).to.equal(
      'browser setup missing; run: node bin/browser_setup.js --bootstrap'
    );
  });

  it('prints only the approved setup keys', function() {
    expect(Object.keys(setup.toPrintEnv({
      chromeBin: '/cache/chrome',
      chromedriverBin: '/cache/chromedriver',
      chromeVersion: '151.0.1.1',
      chromedriverVersion: '151.0.1.1',
      ignored: 'secret',
    })).sort()).to.deep.equal([
      'chromeBin',
      'chromeVersion',
      'chromedriverBin',
      'chromedriverVersion',
    ]);
  });
});
