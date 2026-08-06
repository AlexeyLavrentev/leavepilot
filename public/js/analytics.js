/*
  The Google Analytics snippet, moved out of the layout so that the page carries
  no inline script.

  Rendered only when ga_analytics_on is set, which it is not by default. Worth
  knowing before relying on it: the snippet inserts a script element pointing at
  www.google-analytics.com, which script-src 'self' does not allow, and the
  property it names is a Universal Analytics one - Universal Analytics stopped
  processing data in July 2023. Moving it here changes nothing about either.
*/
(function(i,s,o,g,r,a,m){i['GoogleAnalyticsObject']=r;i[r]=i[r]||function(){
(i[r].q=i[r].q||[]).push(arguments)},i[r].l=1*new Date();a=s.createElement(o),
m=s.getElementsByTagName(o)[0];a.async=1;a.src=g;m.parentNode.insertBefore(a,m)
})(window,document,'script','//www.google-analytics.com/analytics.js','ga');
ga('create', 'UA-63733147-1', 'auto');
ga('send', 'pageview');
