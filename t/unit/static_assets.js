'use strict';

/*
  Stylesheets and scripts under public/ were served from a bare express.static
  mount: no compression at all, and `cache-control: public, max-age=0`, so every
  navigation spent a conditional request on each of the nine local sub-resources.
  A long max-age could not simply replace that, because the paths are stable and
  a browser would hold a stale stylesheet across a deploy.

  These assert the properties the content-addressed mount is supposed to have,
  including the two that are easy to get wrong: a wrong hash must not be cached
  for a year, and a reference the manifest does not know must still resolve.
*/

const expect = require('chai').expect;
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const staticAssets = require('../../lib/ui/static_assets');

describe('Content-addressed static assets', function() {

  const publicRoot = path.join(__dirname, '..', '..', 'public');

  describe('manifest', function() {

    it('covers the stylesheets and scripts the layout links', function() {
      [
        '/css/style.css',
        '/css/bootstrap.min.css',
        '/css/font-awesome.min.css',
        '/js/global.js',
        '/js/jquery.min.js',
        '/js/bootstrap.min.js',
      ].forEach(logical => {
        expect(staticAssets.manifest.has(logical), logical + ' is not fingerprinted').to.equal(true);
      });
    });

    it('keys each file on its own contents, not on a shared build id', function() {
      const hashes = Array.from(staticAssets.manifest.values());

      expect(new Set(hashes).size).to.be.above(
        1,
        'a single shared hash would expire every asset whenever any one of them changes'
      );
    });

    it('puts the hash in the path rather than a query string', function() {
      // Handlebars escapes `=` in an href, so `?v=abc` renders as `?v&#x3D;abc`.
      const url = staticAssets.assetUrl('/css/style.css');

      expect(url).to.not.include('?');
      expect(url).to.match(/^\/assets\/[0-9a-f]{12}\/css\/style\.css$/);
    });

    /*
      The point of the hash is that it follows the bytes actually on disk. A
      manifest keyed on anything else - mtime, size, the release version - would
      still produce plausible URLs while failing to bust the cache on a patch,
      which is the bug the premium stylesheet already hit once.
    */
    it('derives the hash from the bytes the server will send', function() {
      ['/css/style.css', '/js/global.js'].forEach(logical => {
        const onDisk = crypto
          .createHash('sha256')
          .update(fs.readFileSync(path.join(publicRoot, logical.slice(1))))
          .digest('hex')
          .slice(0, 12);

        expect(staticAssets.assetUrl(logical)).to.equal(
          '/assets/' + onDisk + logical,
          logical + ' is fingerprinted with something other than its contents'
        );
      });
    });

    it('returns the original path for a file it does not know', function() {
      expect(staticAssets.assetUrl('/js/not-a-real-file.js')).to.equal('/js/not-a-real-file.js');
      expect(staticAssets.assetUrl('/premium-assets/x/css/premium.css'))
        .to.equal('/premium-assets/x/css/premium.css');
    });
  });

  describe('middleware', function() {

    const requestFor = (urlPath, buildId) => ({
      path: urlPath,
      params: {buildId},
      method: 'GET',
      headers: {},
    });

    // A stand-in for express.static that records the options it was built with
    // and which instance handled the request.
    const fakeExpress = calls => ({
      static: function(root, options) {
        const handler = () => { calls.push(options); };
        handler.options = options;
        return handler;
      },
    });

    it('serves a matching hash immutably for a year', function() {
      const calls = [];
      const middleware = staticAssets.createStaticMiddleware(fakeExpress(calls));
      const hash = staticAssets.manifest.get('/css/style.css');

      middleware(requestFor('/css/style.css', hash), {}, function() {
        throw new Error('should not have fallen through');
      });

      expect(calls).to.have.length(1);
      expect(calls[0].immutable).to.equal(true);
      expect(calls[0].maxAge).to.equal('365d');
    });

    /*
      Someone holding a page rendered before a deploy asks for the previous
      hash. Serving it is right; caching it for a year under a URL that no
      longer describes its contents is not.
    */
    it('serves a stale hash without the long cache', function() {
      const calls = [];
      const middleware = staticAssets.createStaticMiddleware(fakeExpress(calls));

      middleware(requestFor('/css/style.css', 'deadbeefdead'), {}, function() {
        throw new Error('should not have fallen through');
      });

      expect(calls).to.have.length(1);
      expect(calls[0].immutable).to.not.equal(true);
      expect(calls[0].maxAge).to.equal(0);
    });

    it('falls through for a path it has never heard of', function() {
      const calls = [];
      const middleware = staticAssets.createStaticMiddleware(fakeExpress(calls));
      let fellThrough = false;

      middleware(requestFor('/css/nope.css', 'deadbeefdead'), {}, function() {
        fellThrough = true;
      });

      expect(fellThrough).to.equal(true);
      expect(calls).to.have.length(0);
    });
  });

  describe('wiring', function() {

    // Commented-out code still contains the string being looked for, so a plain
    // includes() would keep passing after someone disabled the very line it is
    // meant to guard. Comments come out first.
    const appSource = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8')
      .split('\n')
      .filter(line => !/^\s*\/\//.test(line))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const layout = fs.readFileSync(
      path.join(__dirname, '..', '..', 'views', 'layouts', 'main.hbs'),
      'utf8'
    );

    it('compresses responses, and does so before the static mounts', function() {
      expect(appSource).to.include('app.use(compression());');
      expect(appSource.indexOf('app.use(compression());'))
        .to.be.below(
          appSource.indexOf("express.static(path.join(__dirname, 'public'))"),
          'compression must be mounted before the assets it is meant to compress'
        );
    });

    it('keeps the plain mount so URLs already in the wild still resolve', function() {
      expect(appSource).to.include("app.use(express.static(path.join(__dirname, 'public')));");
    });

    it('links every layout asset through the helper', function() {
      const rawReferences = layout.match(/(?:href|src)=['"]\/(?:css|js)\//g) || [];

      expect(rawReferences).to.deep.equal(
        [],
        'the layout still links an asset by its bare path, which will not be cached'
      );
    });

    it('routes the per-request asset lists through the helper too', function() {
      // custom_css and custom_java_script are pushed to from a dozen routes;
      // fingerprinting them at the point of render covers all of those at once.
      expect(layout).to.include('{{asset this}}');
    });
  });
});
