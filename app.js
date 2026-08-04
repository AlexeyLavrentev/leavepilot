
var express      = require('express');
var compression  = require('compression');
const staticAssets = require('./lib/ui/static_assets');
const MOUNT_PREFIX = staticAssets.MOUNT_PREFIX;
var os           = require('os');
var path         = require('path');
var favicon      = require('serve-favicon');
var cookieParser = require('cookie-parser');
var bodyParser   = require('body-parser');
var moment       = require('moment');
var config       = require('./lib/config');
var branding     = require('./lib/branding');
var edition      = require('./lib/edition');
var emailTemplatePaths = require('./lib/email_template_paths');
var partialTemplatePaths = require('./lib/partial_template_paths');
var features     = require('./lib/features');
const createSessionMiddleware = require('./lib/middleware/withSession');
const i18nextMiddleware = require('i18next-http-middleware');
const { initI18next } = require('./lib/i18n');

var app = express();
var baseViewPath = path.join(__dirname, 'views');
var baseLayoutsPath = path.join(baseViewPath, 'layouts');
var editionContext = {
  app: app,
};

const parseTrustProxy = (value) => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalizedValue = value.toLowerCase();

    if (['true', '1', 'yes', 'on'].includes(normalizedValue)) {
      return 1;
    }

    if (['false', '0', 'no', 'off'].includes(normalizedValue)) {
      return false;
    }
  }

  return value || false;
};

if (typeof os.tmpDir !== 'function') {
  os.tmpDir = os.tmpdir;
}

// View engine setup
var handlebars = require('express-handlebars')
  .create({
    defaultLayout : 'main',
    extname       : '.hbs',
    layoutsDir    : baseLayoutsPath,
    partialsDir   : partialTemplatePaths.get(),
    helpers       : require('./lib/view/helpers')(),
    runtimeOptions: {
      allowProtoMethodsByDefault: true,
      allowProtoPropertiesByDefault: true,
    },
  });

app.engine('.hbs', handlebars.engine);
app.set('view engine', '.hbs');
app.set('views', [baseViewPath]);
app.set('trust proxy', parseTrustProxy(config.get('trust_proxy')));

edition.initialize(editionContext);

// Add single reference to the model into application object
// and reuse it whenever an access to DB is needed
const dbModel = require('./lib/model/db');
app.set('db_model', dbModel);

// uncomment after placing your favicon in /public
//app.use(favicon(__dirname + '/public/favicon.ico'));
// Correlation must wrap every application response, including manifest, static,
// 404, and error responses. Successful static assets are filtered by middleware.
const requestIdMiddleware = require('./lib/middleware/request_id');
app.use(requestIdMiddleware);
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());
app.get('/manifest.webmanifest', function(req, res) {
  var currentBranding = branding.get();

  res.type('application/manifest+json');
  res.send({
    name: currentBranding.name,
    short_name: currentBranding.shortName,
    icons: [
      {
        src: currentBranding.faviconPng32Url,
        sizes: '32x32',
        type: 'image/png',
      },
      {
        src: currentBranding.appIconUrl,
        sizes: '512x512',
        type: 'image/png',
      },
    ],
    theme_color: '#ffffff',
    background_color: '#ffffff',
    display: 'standalone',
  });
});
// Compression before the static mount, so the stylesheets and scripts below
// benefit. A cold page load fetches nine local sub-resources totalling about
// 745KB uncompressed and 151KB gzipped, and none of it was compressed: there is
// no compression middleware here and the shipped compose puts no proxy in front
// of the app to add it.
app.use(compression());

// Content-addressed URLs for the same files, cached for a year and marked
// immutable. See lib/ui/static_assets.js for why a long max-age needs the hash.
app.use(MOUNT_PREFIX + '/:buildId', staticAssets.createStaticMiddleware(express));

// The plain mount stays: anything the manifest does not cover, and any URL
// already out in the wild, keeps working exactly as before.
app.use(express.static(path.join(__dirname, 'public')));

const i18next = initI18next();
app.use(i18nextMiddleware.handle(i18next));



// Setup authentication mechanism
const passport = require('./lib/passport')();

const sessionMiddleware = createSessionMiddleware({
  sequelizeDb: app.get('db_model').sequelize,
});
app.set('session_middleware', sessionMiddleware);
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

// Custom middlewares
//
// Make sure session and user objects are available in templates
app.use(function(req,res,next){

  // Get today given user's timezone
  var today;

  if ( req.user && req.user.company ) {
    today = req.user.company.get_today();
  } else {
    today = moment.utc();
  }

  res.locals.session     = req.session;
  res.locals.logged_user = req.user;
  res.locals.url_to_the_site_root = '/';
  res.locals.requested_path = req.originalUrl;
  res.locals.locale = req.language || 'en';
  res.locals.supported_languages = config.get('supported_languages') || ['en'];
  res.locals.supported_language_options = res.locals.supported_languages.map(code => ({
    code,
    labelKey: `language.names.${code}`,
  }));
  res.locals.current_language_label_key = `language.names.${res.locals.locale}`;
  res.locals.default_language = config.get('default_language') || 'en';
  res.locals.branding = branding.get();
  res.locals.features = features.getEnabledMap();
  res.locals.license_warning = null;
  if (req.user && req.user.admin) {
    const licenseStatus = features.getLicenseStatus();
    if (licenseStatus.source !== 'none') {
      if (licenseStatus.inGrace) {
        res.locals.license_warning = {
          key: 'licenseWarnings.grace',
          expires: licenseStatus.expires,
          graceEndsAt: licenseStatus.graceEndsAt,
        };
      } else if (licenseStatus.reason === 'revoked') {
        res.locals.license_warning = {
          key: 'licenseWarnings.revoked',
        };
      } else if (licenseStatus.reason === 'expired') {
        res.locals.license_warning = {
          key: 'licenseWarnings.expired',
          expires: licenseStatus.expires,
        };
      } else if (licenseStatus.daysUntilExpiry !== null
          && licenseStatus.daysUntilExpiry >= 0
          && licenseStatus.daysUntilExpiry <= 60) {
        res.locals.license_warning = {
          key: 'licenseWarnings.expiring',
          days: licenseStatus.daysUntilExpiry,
          expires: licenseStatus.expires,
        };
      }
    }
  }
  res.locals.primary_premium_nav_items = edition.getNavigationItems({location: 'primary'});
  res.locals.settings_department_premium_nav_items = edition.getNavigationItems({location: 'settings_departments'});
  res.locals.settings_company_premium_nav_items = edition.getNavigationItems({location: 'settings_company'});
  res.locals.disable_notifications = process.env.DISABLE_NOTIFICATIONS_POLLING === 'true';
  res.locals.req = req;
  // For book leave request modal
  res.locals.booking_start = today,
  res.locals.booking_end = today,
  res.locals.keep_team_view_hidden =
    !! (req.user && req.user.company.is_team_view_hidden && ! req.user.admin);

  next();
});

app.use(require('./lib/middleware/page_assets').attachPageAssets);

app.get('/language/:lng', function(req, res) {
  const supportedLanguages = config.get('supported_languages') || ['en'];
  const targetLanguage = req.params.lng;

  if (!supportedLanguages.includes(targetLanguage)) {
    return res.redirect(req.get('Referer') || '/');
  }

  if (req.i18n && req.i18n.changeLanguage) {
    req.i18n.changeLanguage(targetLanguage);
  }

  res.cookie('i18next', targetLanguage);

  return res.redirect(req.get('Referer') || '/');
});

// Enable flash messages within session
app.use( require('./lib/middleware/flash_messages') );

app.use( require('./lib/middleware/session_aware_redirect') );


// CSRF and security headers for all routes
const authSecurity = require("./lib/middleware/auth_security");
app.use(authSecurity.setAuthSecurityHeaders);
app.use(authSecurity.attachCsrfToken);

// Verify CSRF token for POST/PUT/DELETE requests
app.use(function(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return next();
  }

  // Skip CSRF verification for login/register routes as they have their own middleware
  if (req.path.startsWith("/login") || req.path.startsWith("/register") || req.path.startsWith("/forgot-password") || req.path.startsWith("/reset-password")) {
    return next();
  }

  // Registered multipart routes parse their body after this middleware and
  // perform the same constant-time token comparison as soon as fields exist.
  if (authSecurity.shouldDeferMultipartCsrf(req, edition.isMultipartRoute)) {
    return next();
  }

  // For authenticated routes, verify CSRF token
  const sessionToken = req.session && req.session.csrf_token;
  const requestToken = req.body && req.body._csrf || req.headers && req.headers["x-csrf-token"];
  const rejectCsrf = function() {
    const wantsJson = req.xhr
      || /^\/api\//.test(req.originalUrl || req.url || '')
      || (req.accepts && req.accepts(['html', 'json']) === 'json');

    if (wantsJson) {
      return res.status(403).json({error: 'invalid_csrf'});
    }

    if (req.user) {
      req.session.flash_error(req.t ? req.t("login.messages.invalidCsrfToken") : "Invalid CSRF token");
    }
    return res.redirect_with_session(req.originalUrl || req.path || "/");
  };

  if (!sessionToken || !requestToken) {
    return rejectCsrf();
  }

  if (!authSecurity.tokensMatch(sessionToken, requestToken)) {
    return rejectCsrf();
  }

  next();
});

// Here will be publicly accessible routes

app.use(
  '/feed/',
  require('./lib/route/feed')
);

// Extension routes that provide their own authentication (for example bearer
// token APIs) must be mounted before the browser-session authentication wall.
edition.registerPublicRoutes(app, editionContext);


if (process.env.DISABLE_NOTIFICATIONS_POLLING === 'true') {
  app.get('/api/v1/notifications/', function(req, res) {
    res.json({ data: [] });
  });
}

app.use(
  '/',
  require('./lib/route/login')(passport),

  // All rotes bellow are only for authenticated users
  require('./lib/route/dashboard')
);

app.use('/api/v1/', require('./lib/route/api'));

app.use(
  '/calendar/',
  require('./lib/route/calendar')
);

app.use('/settings/company/integration-api', features.requireFeature('integration_api'));

app.use(
  '/settings/',
  require('./lib/route/settings')
);

// '/settings/' path is quite big hence there are two modules providing handlers for it
app.use('/settings/', require('./lib/route/departments'));
app.use('/settings/', require('./lib/route/bankHolidays'));

app.use(
  '/users/',
  // Order of following requires for /users/ matters
  require('./lib/route/users/summary'),
  require('./lib/route/users')
);

app.use(
  '/requests/',
  require('./lib/route/requests')
);

editionContext.passport = passport;

edition.applyViewPaths(app, [baseViewPath], editionContext);
emailTemplatePaths.set(emailTemplatePaths.get().concat(edition.getEmailTemplatePaths(editionContext)));
const activePartialTemplatePaths = partialTemplatePaths.set(
  partialTemplatePaths.get().concat(edition.getPartialTemplatePaths(editionContext))
);
handlebars.partialsDir = activePartialTemplatePaths;
handlebars.config.partialsDir = activePartialTemplatePaths;
edition.registerRoutes(app, editionContext);

app.use(
  '/audit/',
  require('./lib/route/audit')
);

app.use(
  '/reports/',
  require('./lib/route/reports')
);

// catch 404
app.use(function(req, res, next) {
  res.render('not_found');
});


// error handlers
//
// All uncaught route errors end up here. We log them through the structured
// logger (so each error gets a requestId when available) and render an
// appropriate response. Stack traces are never sent to clients in production.

var structuredLogger = require('./lib/middleware/request_logger');
var requestPath = require('./lib/util/request_path');

function logError(err, req) {
  var meta = {
    error: err,
  };

  if (req) {
    meta.requestId = req.requestId;
    meta.method    = req.method;
    meta.path      = requestPath.getSafeRequestPath(req);
    meta.ip        = req.ip;
  }

  structuredLogger.error('unhandled_request_error', meta);
}

// development error handler — will print stacktrace
if (app.get('env') === 'development') {
    app.use(function(err, req, res, next) {
        logError(err, req);
        res.status(err.status || 500);
        res.render('error', {
            message: err.message,
            error: err
        });
    });
}

// production error handler — no stacktraces leaked to user
app.use(function(err, req, res, next) {
    logError(err, req);
    res.status(err.status || 500);
    res.render('error', {
        message: err.message,
        error: {}
    });
});

module.exports = app;
