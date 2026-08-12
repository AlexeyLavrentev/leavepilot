
"use strict";

var
  moment    = require('moment'),
  moment_tz = require('moment-timezone'),
  config    = require('../config'),
  branding  = require('../branding'),
  features  = require('../features');
const { i18next, initI18next } = require('../i18n');
const staticAssets = require('../ui/static_assets');

initI18next();

const serializeForInlineScript = value => {
  const serialized = JSON.stringify(value);

  if (typeof serialized !== 'string') {
    return serialized;
  }

  return serialized
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
};

var as_date_formatted = function(date_str, format, options) {

  if (! date_str) return '';

  var locale = get_property_from_options(options, 'locale')
    || (options && options.data && options.data.root && options.data.root.req && options.data.root.req.language)
    || config.get('default_language')
    || 'en';

  if ( ! format ) {
    format = get_current_format( options );
  }

  // Special case when we have to take time zone into consideration
  // when printing date (usually it is needed for those dates recorded
  // automatically as UTC time stampts)
  if ( options.tom_take_timezone_into_consideration ) {
    return moment_tz.utc(date_str).tz( get_timezone( options ) ).locale(locale).format( format );
  }

  return moment.utc(date_str).locale(locale).format(format);
}

// Note: that currently it returns only truely value of given property, that is if there property
// exists and its value is falsy, that undef is returned back
var get_property_from_options = function(options, property_name){
  var value;

  if ( options.hasOwnProperty('data')
    && options.data.hasOwnProperty('root')
    && options.data.root.hasOwnProperty(property_name)
    && options.data.root[property_name]
  ) {
    value = options.data.root[property_name];
  }

  return value;
};

var get_current_format = function(options){

  var format = 'YYYY-MM-DD';

  var user = get_property_from_options(options, 'logged_user')
    || get_property_from_options(options, 'user');

  if ( user && user.hasOwnProperty('company') ) {
    format = user.company.get_default_date_format();
  }

  return format;
};

var get_timezone = function(options) {

  let timezone = 'Europe/London';

  var user = get_property_from_options(options, 'logged_user')
    || get_property_from_options(options, 'user');

  if ( user && user.hasOwnProperty('company') ) {
    timezone = user.company.timezone;
  }

  return timezone;
};

module.exports = function(){
  return {
    // Handlebars does not allow to have conditions in IF, here is
    // workaround picked from here: http://stackoverflow.com/questions/8853396/logical-operator-in-a-handlebars-js-if-conditional
    if_equal :  function(v1, v2, options){
      if(v1 === v2) {
        return options.fn(this);
      }
      return options.inverse(this);
    },

    // Given string with UTC date return string with date formated in customer specific manner
    as_date : function(date_string, options) {

      return as_date_formatted(date_string, undefined, options);
    },

    // Return string with given date formated as a timestamp
    as_datetime : function (date_str, options) {
      return as_date_formatted(
        date_str,
        get_current_format(options) + ' HH:mm:ss',
        options
      );
    },

    // Do the same as "as_date" method but takes into consideration of company
    // timezone. It is needed for rendering dates that were recorded in database
    // automatically in UTC, dates that were recorded based on explicit input
    // from users should not be used with this method (but with "as_date" instead)
    as_date_from_timestamp : function(date_string, options){

      // Add custom flag to options so further down the call stack
      // we would know that date needs to be corrected with
      // current timezone
      options.tom_take_timezone_into_consideration = true;

      return as_date_formatted(date_string, undefined, options);
    },

    // Similar to "as_datetime" but with the same twist as "as_date_from_timestamp"
    as_datetime_from_timestamp : function(date_str, options){

      // Add custom flag to options so further down the call stack
      // we would know that date needs to be corrected with
      // current timezone
      options.tom_take_timezone_into_consideration = true;

      return as_date_formatted(
        date_str,
        get_current_format(options) + ' HH:mm:ss',
        options
      );
    },

    // Given string with UTC date and string with moment.js format return corresponding string
    as_date_formatted : as_date_formatted,

    is_calendar_weekend : function(date) {
      if (!date) {
        return false;
      }

      const weekDay = moment(date).day();

      return weekDay === 0 || weekDay === 6;
    },

    // Get access to config value holding application domain
    get_application_domain : function() {
      return branding.get().applicationDomain;
    },

    // Return URL to the web site with promotion materials.
    get_promotion_website_domain : function() {
      return branding.get().promotionWebsiteDomain;
    },

    brand_name : function() {
      return branding.get().name;
    },

    feature_enabled : function(featureName, options) {
      const enabled = features.isEnabled(featureName);

      if (options && typeof options.fn === 'function') {
        return enabled ? options.fn(this) : options.inverse(this);
      }

      return enabled;
    },

    concatenate : function() {
      var arg = Array.prototype.slice.call(arguments,0);
      arg.pop();
      return arg.join('');
    },

    is_force_to_explicitly_select_type_when_requesting_new_leave: function (options) {
      if (!!config.get('force_to_explicitly_select_type_when_requesting_new_leave')) {
        return options.fn(this);
      }

      return options.inverse(this);
    },

    t: function(key, options) {
      if (!options) {
        return key;
      }

      const hash = Object.assign({}, options.hash);

      if (key === 'brand.name') {
        return branding.get().name;
      }

      if (key === 'brand.nameLower') {
        return branding.get().name.toLowerCase();
      }

      // Login screen + home page render the visible product name from the
      // dynamic brand layer (D-09), not a locale literal — so a rebrand
      // reaches every language without a translator touching JSON.
      if (key === 'login') {
        return branding.get().name;
      }

      if (key === 'home.title') {
        return branding.get().name;
      }

      const locale = hash.lng
        || get_property_from_options(options, 'locale')
        || (options.data && options.data.root && options.data.root.req && options.data.root.req.language)
        || config.get('default_language')
        || 'en';

      hash.lng = locale;

      if (options.data && options.data.root && options.data.root.req && options.data.root.req.t) {
        return options.data.root.req.t(key, hash);
      }

      return i18next.t(key, hash);
    },

    json: function(context) {
      return serializeForInlineScript(context);
    },

    uses_external_auth: function(company, options) {
      const enabled = !!(
        company && (
          (typeof company.uses_external_auth === 'function' && company.uses_external_auth())
          || company.ldap_auth_enabled
          || company.sso_auth_enabled
        )
      );

      if (options && typeof options.fn === 'function') {
        return enabled ? options.fn(this) : options.inverse(this);
      }

      return enabled;
    },

    full_name: function(user) {
      if (!user) {
        return '';
      }

      if (typeof user.full_name === 'function') {
        return user.full_name();
      }

      if (user.full_name) {
        return user.full_name;
      }

      if (user.name || user.lastname) {
        return `${user.name || ''} ${user.lastname || ''}`.trim();
      }

      return '';
    },

    /*
      Content-addressed URL for a file under public/. Falls back to the path it
      was given when the manifest does not know it, so a reference this misses
      still resolves through the plain static mount.
    */
    asset : function(logicalPath) {
      return staticAssets.assetUrl(logicalPath);
    },

  };
};
