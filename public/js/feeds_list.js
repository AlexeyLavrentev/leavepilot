/*
  The calendar feed list's copy-to-clipboard and reveal controls.

  Moved out of the page so that no page carries inline script: with
  'unsafe-inline' in script-src an injected <script> runs exactly as this does,
  and dropping it is most of what the header is for. Linked from the feeds route
  rather than from the layout, because only that page has these controls.
*/
(function() {
  document.querySelectorAll('.feed-copy-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var targetId = btn.getAttribute('data-clipboard-target');
      var codeEl = document.querySelector(targetId);
      if (!codeEl) return;
      var text = codeEl.textContent.trim();

      function showFeedback(success) {
        var originalHTML = btn.innerHTML;
        var icon = document.createElement('span');
        icon.className = success ? 'fa fa-check' : 'fa fa-exclamation-triangle';
        icon.setAttribute('aria-hidden', 'true');
        btn.textContent = '';
        btn.appendChild(icon);
        btn.appendChild(document.createTextNode(' ' + btn.getAttribute(success ? 'data-copy-success' : 'data-copy-failure')));
        btn.classList.add(success ? 'btn-success' : 'btn-danger');
        btn.classList.remove('btn-default');
        setTimeout(function() {
          btn.innerHTML = originalHTML;
          btn.classList.remove('btn-success');
          btn.classList.remove('btn-danger');
          btn.classList.add('btn-default');
        }, 2000);
      }

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function() { showFeedback(true); }).catch(function() {
          fallbackCopy(text, showFeedback);
        });
      } else {
        fallbackCopy(text, showFeedback);
      }
    });
  });

  function fallbackCopy(text, cb) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { cb(Boolean(document.execCommand('copy'))); } catch(e) { cb(false); }
    document.body.removeChild(ta);
  }
})();
