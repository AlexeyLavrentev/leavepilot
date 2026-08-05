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

module.exports = function notFound(req, res) {
  res.status(404).render('not_found');
};
