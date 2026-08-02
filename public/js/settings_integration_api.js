(function () {
  'use strict';

  var page = document.querySelector('.integration-api-page');
  if (!page) return;

  var regenerateButton = page.querySelector('#regenerate_token_btn');
  var copyButton = page.querySelector('#copy_token_btn');
  var tokenInput = page.querySelector('#token-value');
  var copyStatus = page.querySelector('#copy_token_status');

  if (regenerateButton) {
    regenerateButton.addEventListener('click', function (event) {
      var message = regenerateButton.getAttribute('data-confirm-message');
      if (message && !window.confirm(message)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  }

  if (!copyButton || !tokenInput || !copyStatus) return;

  function announce(message) {
    copyStatus.textContent = '';
    window.setTimeout(function () {
      copyStatus.textContent = message;
    }, 20);
  }

  function fallbackCopy() {
    tokenInput.focus();
    tokenInput.select();
    tokenInput.setSelectionRange(0, tokenInput.value.length);
    return document.execCommand('copy');
  }

  copyButton.addEventListener('click', function () {
    var successMessage = copyButton.getAttribute('data-copy-success');
    var failureMessage = copyButton.getAttribute('data-copy-failure');
    var copy = navigator.clipboard && navigator.clipboard.writeText
      ? navigator.clipboard.writeText(tokenInput.value).then(function () { return true; })
      : Promise.resolve(fallbackCopy());

    copy.then(function (copied) {
      announce(copied ? successMessage : failureMessage);
    }).catch(function () {
      announce(failureMessage);
    });
  });
}());
