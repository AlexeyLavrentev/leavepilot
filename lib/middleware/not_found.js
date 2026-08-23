'use strict';

/*
  The last handler in the chain: a request that matched no route renders the
  not-found page.

  It has to carry 404 with it. The page has said "404" in its own text since it
  was written, while the response said 200 - so a crawler indexed every mistyped
  URL as a real page, an uptime check pointed at a route that had been renamed
  went on reporting healthy, and a fetch() in the app that asked for a path that
  no longer exists took an HTML error page for a successful answer.

  The original handler built a 404 error and forwarded it to the error handler.
  It was replaced by a direct render in 700aa6c, and the status went with it.
*/

/*
  An API client asking for a path that is not there got the HTML not-found page.
  It parses as neither JSON nor an error it can report, so a mistyped or renamed
  endpoint surfaced as a parse failure somewhere else entirely.

  Decided on the path rather than on Accept: every API router in either edition
  is mounted under /api/, and a browser that accepts anything at all when it
  asks for a page should keep getting the page. The shape matches what those routers already answer
  with - res.status(...).json({error}) - so a client has one thing to read
  whichever end of the route it reached.
*/
const wantsJson = req => /^\/api(\/|$)/.test(req.path || '');

module.exports = function notFound(req, res) {
  if (wantsJson(req)) {
    return res.status(404).json({
      error: (req.t ? req.t('notFound.title') : 'Page not found'),
    });
  }

  return res.status(404).render('not_found');
};
