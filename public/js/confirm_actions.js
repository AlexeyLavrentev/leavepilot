(function () {
  'use strict';

  /*
    Confirmation before something irreversible.

    These guards used to be written into the markup:

      <form ... onsubmit="return confirm('Delete this employee?')">

    An inline event handler is script, and script-src 'self' does not allow
    it - so once 'unsafe-inline' came out of the Content-Security-Policy the
    browser stopped installing them. Nothing failed loudly. The attribute is
    still in the DOM and reads as a guard:

      {"formFound":true,"attributePresent":true,"handlerInstalled":false}

    while typeof form.onsubmit is "object", not "function". Pressing Delete
    deleted, with no dialog.

    So the message moves to a data attribute, which is data, and the handler
    lives here. data-confirm-message is already the convention on the bank
    holidays, general settings and integration API screens; this is the same
    thing, applied to whatever carries the attribute, on every page.
  */

  var ATTRIBUTE = 'data-confirm-message';

  var refuse = function (event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  /*
    Capture, so this runs before any handler bound by the page's own script -
    otherwise a listener that submits the form directly would get there first
    and the answer would arrive too late to matter.
  */
  document.addEventListener('submit', function (event) {
    var form = event.target;

    if (!form || !form.getAttribute) {
      return;
    }

    var message = form.getAttribute(ATTRIBUTE);

    if (message && !window.confirm(message)) {
      refuse(event);
    }
  }, true);

  document.addEventListener('click', function (event) {
    // The attribute may be on the button or on something it sits inside.
    var element = event.target;

    while (element && element.getAttribute) {
      var message = element.getAttribute(ATTRIBUTE);

      if (message) {
        if (!window.confirm(message)) {
          refuse(event);
        }
        return;
      }

      element = element.parentElement;
    }
  }, true);
})();
