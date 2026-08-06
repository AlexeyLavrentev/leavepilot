/*
  Publishes the per-request configuration the page scripts read.

  It used to be an inline `window.timeoff = {...}` assignment. The values still
  come from the server and are still rendered into the page - but as data, in a
  <script type="application/json"> block, which the browser does not execute and
  which script-src therefore does not govern. This reads that block.

  Loaded before anything that uses it, which is what the inline assignment
  guaranteed by sitting where this now sits.
*/
(function() {
  var node = document.getElementById('timeoff-config');

  if (!node) {
    window.timeoff = window.timeoff || {};
    return;
  }

  try {
    window.timeoff = JSON.parse(node.textContent);
  } catch (e) {
    // A malformed block should not take the page's scripts down with it.
    window.timeoff = {};
  }
})();
