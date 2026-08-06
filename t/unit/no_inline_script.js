'use strict';

/*
  The Content-Security-Policy allowed 'unsafe-inline' in script-src, which is
  most of a CSP given away: with it, an injected <script> runs exactly as the
  page's own scripts do, and stopping that is what the header is most often
  deployed for. It was there because the layout and two settings pages carried
  their script inline.

  What replaced it:

  - the layout's theme bootstrap is a blocking <script src> in the head, which
    holds rendering exactly as an inline script does, so there is still no flash
    of the light theme;
  - what the server has to hand the page is rendered into a
    <script type="application/json"> block. The browser parses that as data
    rather than executing it, so script-src does not govern it;
  - the two page scripts are files, linked by their routes;
  - the only inline styles left outside the email templates were two progress
    bars, whose width now comes from the value they already report to assistive
    technology, applied through the CSSOM - which CSP does not cover.

  Email templates are exempt throughout: they are not served to a browser under
  this header, and mail clients need their styles inline.

  Kept as a test rather than done once. Inline script is the natural way to
  write a five-line handler, nothing else would notice it coming back, and the
  header would then be a promise the pages do not keep.
*/

const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const viewsRoot = path.join(root, 'views');

const templates = (function collect(directory) {
  return fs.readdirSync(directory, {withFileTypes: true}).reduce((files, entry) => {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return files.concat(collect(entryPath));
    }

    return entry.name.endsWith('.hbs') ? files.concat(entryPath) : files;
  }, []);
})(viewsRoot);

const relative = file => path.relative(root, file);

// Mail is not served under this header, and a mail client needs its CSS where
// it can see it.
const servedToBrowsers = templates.filter(file => !relative(file).split(path.sep).includes('email'));

const read = file => fs.readFileSync(file, 'utf8');

const csp = (function() {
  const source = read(path.join(root, 'lib', 'middleware', 'auth_security.js'));
  const found = source.match(/'Content-Security-Policy',\s*"([^"]+)"/);

  return found ? found[1] : '';
})();

const directive = name => {
  const found = csp.split(';').map(part => part.trim()).find(part => part.startsWith(name + ' '));

  return found ? found.slice(name.length + 1).trim() : null;
};

describe('No page carries inline script', function() {

  describe('the header', function() {

    it('is still set', function() {
      expect(csp).to.include("default-src 'self'");
    });

    it('does not allow inline script', function() {
      expect(directive('script-src')).to.equal(
        "'self'",
        'script-src allows something beyond the origin'
      );
    });

    it('does not allow inline style', function() {
      expect(directive('style-src')).to.not.match(/unsafe-inline/);
    });

    it('keeps the rest of what it had', function() {
      ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"]
        .forEach(part => expect(csp).to.include(part));
    });
  });

  describe('the templates', function() {

    it('has templates to check', function() {
      expect(servedToBrowsers.length).to.be.above(10);
    });

    it('has no executable <script> block in any of them', function() {
      const offenders = servedToBrowsers.filter(file => {
        const blocks = read(file).match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g) || [];

        return blocks.some(block => {
          const body = block.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '').trim();

          // A JSON block is data: the browser does not run it, and script-src
          // does not apply to it.
          return body.length > 0 && !/type\s*=\s*["']application\/json["']/.test(block);
        });
      });

      expect(offenders.map(relative)).to.deep.equal([]);
    });

    it('has no style attribute in any of them', function() {
      const offenders = servedToBrowsers.filter(file => /\sstyle\s*=\s*["']/.test(read(file)));

      expect(offenders.map(relative)).to.deep.equal([]);
    });

    it('leaves the email templates alone', function() {
      const emails = templates.filter(file => relative(file).split(path.sep).includes('email'));

      expect(emails.length).to.be.above(0);
      expect(
        emails.some(file => /<style|\sstyle\s*=/.test(read(file))),
        'the exemption is now protecting nothing, so it can go'
      ).to.equal(true);
    });
  });

  describe('what the layout does instead', function() {

    const layout = read(path.join(viewsRoot, 'layouts', 'main.hbs'));

    /*
      Blocking, and in the head. Deferred or at the end of the body it would run
      after the first paint, which is a flash of the light theme for anyone who
      chose the dark one.
    */
    it('decides the theme from a blocking script in the head', function() {
      const head = layout.slice(0, layout.indexOf('</head>'));

      expect(head).to.include("theme_boot.js");
      expect(head).to.not.match(/theme_boot\.js[^>]*\b(defer|async)\b/);
    });

    it('renders its configuration as data', function() {
      expect(layout).to.match(/<script type="application\/json" id="timeoff-config">/);
      expect(layout).to.include('config_boot.js');
    });

    /*
      The json helper escapes < > and &, so no value rendered into the block can
      close the element it sits in. Without that, a branding string containing
      "</script>" would break out of it.
    */
    it('escapes what it renders into that block', function() {
      const helpers = read(path.join(root, 'lib', 'view', 'helpers.js'));

      expect(helpers).to.match(/replace\(\/<\/g, '\\\\u003c'\)/);
      expect(helpers).to.match(/replace\(\/>\/g, '\\\\u003e'\)/);
    });

    it('publishes the configuration before anything reads it', function() {
      expect(layout.indexOf('config_boot.js')).to.be.below(
        layout.indexOf('custom_java_script'),
        'the page scripts would run before window.timeoff exists'
      );
    });
  });

  describe('the page scripts', function() {

    it('are linked by the routes that render them', function() {
      expect(read(path.join(root, 'lib', 'route', 'calendar.js')))
        .to.include("custom_java_script.push('/js/feeds_list.js')");
      expect(read(path.join(root, 'lib', 'route', 'reminder_schedules.js')))
        .to.include("custom_java_script.push('/js/reminder_schedules.js')");
    });

    it('exist', function() {
      // analytics.js is not here: the snippet it held is gone. It pointed at a
      // host script-src does not allow and at a Universal Analytics property,
      // which stopped taking data in July 2023.
      ['feeds_list.js', 'reminder_schedules.js', 'theme_boot.js', 'config_boot.js']
        .forEach(name => {
          expect(
            fs.existsSync(path.join(root, 'public', 'js', name)),
            name + ' is linked but not shipped'
          ).to.equal(true);
        });
    });

    /*
      A template expression left in an extracted file is not a syntax error - it
      is a string that reads as `{{t "..."}}` to the user. The reminder screen
      had nineteen of them.
    */
    it('carry no template expressions', function() {
      ['feeds_list.js', 'reminder_schedules.js', 'theme_boot.js', 'config_boot.js']
        .forEach(name => {
          const source = fs.readFileSync(path.join(root, 'public', 'js', name), 'utf8');

          expect(source, name + ' still has a handlebars expression in it')
            .to.not.match(/\{\{[^}]*\}\}/);
        });
    });

    it('take their labels and token from data instead', function() {
      const script = read(path.join(root, 'public', 'js', 'reminder_schedules.js'));

      expect(script).to.include("getElementById('reminder-schedules-config')");
      expect(script).to.include('(window.timeoff || {}).csrfToken');

      expect(read(path.join(viewsRoot, 'reminder_schedules_settings.hbs')))
        .to.match(/<script type="application\/json" id="reminder-schedules-config">/);
    });
  });

  describe('the progress bars', function() {

    it('take their width from the value they already report', function() {
      const global = read(path.join(root, 'public', 'js', 'global.js'));

      expect(global).to.include(".progress-bar[aria-valuenow]");
      expect(global).to.match(/bar\.style\.width\s*=/);
    });

    it('still report it', function() {
      const absences = read(path.join(viewsRoot, 'partials', 'user_details', 'absences.hbs'));

      expect((absences.match(/aria-valuenow=/g) || []).length).to.equal(2);
    });

    /*
      Bootstrap gives .progress-bar a width of 0 and a 0.6s width transition.
      With the width in the markup that transition never ran; applying it from
      script means the bars grow into place, which is motion that was not there
      before.
    */
    it('do not animate when the reader asked for less motion', function() {
      const css = read(path.join(root, 'public', 'css', 'style.css'));
      const at = css.indexOf('.employee-allowance-progress .progress-bar');

      expect(at).to.be.above(-1);
      expect(css.slice(at, at + 600)).to.match(
        /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,200}transition:\s*none/
      );
    });
  });
});
