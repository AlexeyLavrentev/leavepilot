'use strict';

/*
  Content-addressed URLs for the stylesheets and scripts under public/.

  These files were served from a bare express.static mount, which sends
  `cache-control: public, max-age=0`. That is not as bad as it sounds — express
  sets an ETag, so a repeat visitor gets 304s rather than re-downloading — but it
  does mean every page navigation spends a conditional request on each of the
  nine local sub-resources before it can paint. Nine round trips per navigation,
  forever, for files that almost never change.

  A long max-age cannot simply be turned on instead: the paths are stable, so a
  browser would hold a stale stylesheet across a deploy. Putting a hash of the
  file's own contents in its URL fixes both halves at once — the response can be
  cached for a year and marked immutable, and a changed file is a changed URL, so
  the stale copy is never asked for again.

  Per file rather than one build id for the whole set: a one-line fix to
  global.js should not expire bootstrap and jQuery along with it.

  The plain /css and /js mount stays in place. Anything this manifest does not
  know about keeps working exactly as before, and assetUrl falls back to the
  original path rather than inventing a URL that would 404.
*/

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PUBLIC_ROOT = path.join(__dirname, '..', '..', 'public');
const FINGERPRINTED_DIRECTORIES = ['css', 'js'];
const MOUNT_PREFIX = '/assets';
const HASH_LENGTH = 12;

const hashFile = filePath => crypto
  .createHash('sha256')
  .update(fs.readFileSync(filePath))
  .digest('hex')
  .slice(0, HASH_LENGTH);

/*
  Built once at boot. The files are part of the deployed image and cannot change
  under a running process, so re-reading them per request would buy nothing.
*/
const buildManifest = () => {
  const manifest = new Map();

  FINGERPRINTED_DIRECTORIES.forEach(directory => {
    const absolute = path.join(PUBLIC_ROOT, directory);

    let entries;

    try {
      entries = fs.readdirSync(absolute, {withFileTypes: true});
    } catch {
      // A directory that is not there is not an error: an edition may ship
      // without one, and the fallback path keeps every reference working.
      return;
    }

    entries
      .filter(entry => entry.isFile())
      .forEach(entry => {
        const logical = '/' + directory + '/' + entry.name;
        manifest.set(logical, hashFile(path.join(absolute, entry.name)));
      });
  });

  return manifest;
};

const manifest = buildManifest();

const assetUrl = logicalPath => {
  const hash = manifest.get(logicalPath);

  return hash ? MOUNT_PREFIX + '/' + hash + logicalPath : logicalPath;
};

/*
  The hash is verified rather than ignored, because serving any hash would let a
  wrong URL be cached for a year against whatever the current bytes happen to be.

  A mismatch is still served, just without the long cache. Someone holding a page
  rendered before a deploy asks for the previous hash, and the honest answer is
  the current file with ordinary revalidation — better than a 404 that breaks
  their page, and better than a year-long cache under a URL that no longer
  describes its contents. A path the manifest has never heard of falls through to
  the plain mount.
*/
const createStaticMiddleware = express => {
  const options = {
    dotfiles: 'ignore',
    index: false,
    redirect: false,
  };

  const serveImmutable = express.static(PUBLIC_ROOT, Object.assign({}, options, {
    immutable: true,
    maxAge: '365d',
  }));

  const serveRevalidating = express.static(PUBLIC_ROOT, Object.assign({}, options, {
    maxAge: 0,
  }));

  return (req, res, next) => {
    const expected = manifest.get(req.path);

    /*
      A path with no manifest entry is still served from here rather than
      falling through, because a fingerprinted stylesheet drags its siblings
      along with it. font-awesome.min.css says url('../fonts/…'), and the
      browser resolves that against the URL the stylesheet came from - so it
      asks for /assets/<the stylesheet's hash>/fonts/…, which this manifest has
      never heard of.

      Falling through sent those to the router, which answered a redirect. The
      browser got HTML where it expected a font: "invalid sfntVersion
      1008813135" is 0x3C21444F, the bytes "<!DO". Every icon in the app
      rendered as a box.

      Revalidating rather than immutable: the hash in the URL belongs to the
      stylesheet, not to the file being served, so it says nothing about this
      file's contents and must not be cached for a year on that basis.
    */
    if (!expected) {
      return serveRevalidating(req, res, next);
    }

    return expected === req.params.buildId
      ? serveImmutable(req, res, next)
      : serveRevalidating(req, res, next);
  };
};

module.exports = {
  MOUNT_PREFIX,
  assetUrl,
  createStaticMiddleware,
  manifest,
};
