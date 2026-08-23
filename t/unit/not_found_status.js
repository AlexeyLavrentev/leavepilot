'use strict';

/*
  The not-found page said "404" in its own body while the response said 200.

  Nothing looks wrong on screen, which is why it stood for eight years: the
  reader sees the right page. Everything that reads the status rather than the
  page was told a mistyped URL was a real one - crawlers indexing them, uptime
  checks pointed at a renamed route reporting healthy, and any fetch() in the
  app taking an HTML error page for a successful answer.

  The original handler built a 404 and forwarded it to the error handler; the
  direct render that replaced it in 700aa6c dropped the status.

  A status is not visible in the rendered page, so it can only be pinned here.
*/

const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');
const notFound = require('../../lib/middleware/not_found');

// Records the order of the calls as well as the arguments: a status set after
// the response has been rendered is a status that never reaches the client.
const fakeResponse = () => {
  const calls = [];
  const res = {
    calls,
    status(code) { calls.push(['status', code]); return res; },
    render(view) { calls.push(['render', view]); return res; },
  };

  return res;
};

describe('A request that matched no route', function() {

  describe('the handler', function() {

    it('answers 404 rather than 200', function() {
      const res = fakeResponse();

      notFound({}, res);

      expect(res.calls).to.deep.include(['status', 404]);
    });

    it('still renders the page a reader expects to see', function() {
      const res = fakeResponse();

      notFound({}, res);

      expect(res.calls).to.deep.include(['render', 'not_found']);
    });

    it('sets the status before rendering, not after', function() {
      const res = fakeResponse();

      notFound({}, res);

      const status = res.calls.findIndex(call => call[0] === 'status');
      const render = res.calls.findIndex(call => call[0] === 'render');

      expect(status).to.be.below(
        render,
        'a status set after the render never reaches the client'
      );
    });

    /*
      Not next(): there is nothing after it to hand the request to, and the
      error handlers below it are for uncaught errors rather than for a path
      that simply is not there.
    */
    it('ends the request rather than passing it on', function() {
      let passedOn = false;

      notFound({}, fakeResponse(), function() { passedOn = true; });

      expect(passedOn).to.equal(false);
    });
  });

  describe('where it is mounted', function() {

    // Commented-out code still contains the string being looked for, so a plain
    // includes() would keep passing after someone disabled the line it guards.
    const appSource = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8')
      .split('\n')
      .filter(line => !/^\s*\/\//.test(line))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '');

    it('is mounted', function() {
      expect(appSource).to.include("app.use(require('./lib/middleware/not_found'));");
    });

    it('comes after the routes, so a real page is never mistaken for a missing one', function() {
      expect(appSource.indexOf("require('./lib/route/reports')")).to.be.below(
        appSource.indexOf("require('./lib/middleware/not_found')")
      );
      expect(appSource.indexOf('edition.registerRoutes(app, editionContext)')).to.be.below(
        appSource.indexOf("require('./lib/middleware/not_found')")
      );
    });

    it('comes before the error handlers, which are for a different failure', function() {
      expect(appSource.indexOf("require('./lib/middleware/not_found')")).to.be.below(
        appSource.indexOf('app.use(function(err, req, res, _next)')
      );
    });
  });
});
