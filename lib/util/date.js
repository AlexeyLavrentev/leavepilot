'use strict';

/*
  Centralised dayjs configuration.  Every file that needs date work
  imports from here instead of touching dayjs directly, so plugins are
  registered exactly once and the locale/timezone setup is consistent.

  Drop-in replacement for dayjs: the exported `dayjs` instance has
  utc, timezone, locale, isBetween, isSameOrBefore, isSameOrAfter,
  and customParseFormat plugins pre-loaded.
*/

var dayjs = require('dayjs');

// Plugins (order matters: customParseFormat must come before utc)
dayjs.extend(require('dayjs/plugin/customParseFormat'));
dayjs.extend(require('dayjs/plugin/utc'));
dayjs.extend(require('dayjs/plugin/timezone'));
dayjs.extend(require('dayjs/plugin/isBetween'));
dayjs.extend(require('dayjs/plugin/isSameOrBefore'));
dayjs.extend(require('dayjs/plugin/isSameOrAfter'));
dayjs.extend(require('dayjs/plugin/isLeapYear'));
dayjs.extend(require('dayjs/plugin/weekday'));
dayjs.extend(require('dayjs/plugin/isoWeek'));
dayjs.extend(require('dayjs/plugin/weekOfYear'));
dayjs.extend(require('dayjs/plugin/dayOfYear'));
dayjs.extend(require('dayjs/plugin/localeData'));
dayjs.extend(require('dayjs/plugin/relativeTime'));

// Locale imports (match the languages the app supports)
require('dayjs/locale/ru');
require('dayjs/locale/uk');
require('dayjs/locale/be');
require('dayjs/locale/kk');

// Timezone names list (replaces moment-timezone's .names())
// Uses Intl API which is available in Node.js 18+.
dayjs.tzNames = function() {
  return Intl.supportedValuesOf('timeZone');
};

module.exports = dayjs;
