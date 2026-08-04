'use strict';

/*
  Which stylesheets and scripts each page links.

  All four used to be pushed onto every response. Three of them exist for the
  booking modal and the authenticated forms, so a visitor on the login page
  downloaded 53KB of date-picker script and a 30KB stylesheet that nothing on
  that page could use — and with no session, nothing on any page they could
  reach could use either. Measured on a logged-out /login/: nine local
  sub-resources and 13.6KB of HTML, against six and 8.8KB once these are gated.

  Routes push their own entries onto these arrays afterwards, so both are
  always arrays and the order here is the order they load in.
*/

// The date picker has to be parsed before anything that reaches for it, and
// leave_forecast is one of those things.
const DATE_PICKER_SCRIPT = '/js/bootstrap-datepicker.js';
const DATE_PICKER_STYLESHEET = '/css/bootstrap-datepicker3.standalone.css';
const LEAVE_FORECAST_SCRIPT = '/js/leave_forecast.js';

// Drives the navigation and the table scroll cues, which every page has.
const GLOBAL_SCRIPT = '/js/global.js';

const attachPageAssets = (req, res, next) => {
  res.locals.custom_java_script = [GLOBAL_SCRIPT];
  res.locals.custom_css = [];

  if (req.user) {
    res.locals.custom_java_script.unshift(DATE_PICKER_SCRIPT);
    res.locals.custom_java_script.push(LEAVE_FORECAST_SCRIPT);
    res.locals.custom_css.push(DATE_PICKER_STYLESHEET);
  }

  next();
};

module.exports = {
  attachPageAssets,
  DATE_PICKER_SCRIPT,
  DATE_PICKER_STYLESHEET,
  GLOBAL_SCRIPT,
  LEAVE_FORECAST_SCRIPT,
};
