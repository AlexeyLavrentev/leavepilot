/*
  Applies the stored theme before the page paints.

  Loaded with a blocking <script src> in <head> rather than inlined: the
  Content-Security-Policy no longer allows inline script, and a blocking
  external script in the head holds rendering exactly as an inline one does, so
  there is still no flash of the light theme on the way to the dark one. The
  cost is one round trip on a cold cache, against a file that is
  content-addressed and cached for a year after that.
*/
(function() {
  try {
    var theme = localStorage.getItem('timeoff-theme');

    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  } catch (e) {
    // Ignore theme preferences when storage is unavailable.
  }
})();
