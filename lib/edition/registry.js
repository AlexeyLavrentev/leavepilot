'use strict';

const features = require('../features');

const cloneRoute = route => ({
  name       : route.name,
  path       : route.path,
  placement  : route.placement,
  middleware : Array.isArray(route.middleware) ? route.middleware.slice() : [],
  router     : route.router,
});

const cloneScheduler = scheduler => ({
  name  : scheduler.name,
  start : scheduler.start,
});

const cloneNavigationItem = item => Object.assign({}, item);
const cloneNotificationProvider = provider => Object.assign({}, provider);
const cloneDiagnostic = diagnostic => Object.assign({}, diagnostic);
const cloneViewPath = viewPath => viewPath;
const cloneEmailTemplatePath = emailTemplatePath => emailTemplatePath;
const clonePartialTemplatePath = partialTemplatePath => partialTemplatePath;
const cloneDbModelPath = dbModelPath => dbModelPath;
const cloneLocalePath = localePath => localePath;
const cloneMigrationPath = migrationPath => migrationPath;
const cloneDbAssociation = dbAssociation => ({
  name      : dbAssociation.name,
  associate : dbAssociation.associate,
});

function EditionRegistry() {
  this.routes = [];
  this.schedulers = [];
  this.navigationItems = [];
  this.notificationProviders = [];
  this.diagnostics = [];
  this.viewPaths = [];
  this.emailTemplatePaths = [];
  this.partialTemplatePaths = [];
  this.dbModelPaths = [];
  this.localePaths = [];
  this.migrationPaths = [];
  this.dbAssociations = [];
  this.multipartRoutes = [];
}

EditionRegistry.prototype.registerMultipartRoute = function(route) {
  if (!route || route.method !== 'POST' || typeof route.path !== 'string'
      || route.path.charAt(0) !== '/' || route.path.charAt(route.path.length - 1) !== '/') {
    throw new Error('Edition multipart route requires an exact trailing-slash POST path');
  }

  if (this.multipartRoutes.some(item => item.method === route.method && item.path === route.path)) {
    throw new Error('Edition multipart route already registered: ' + route.method + ' ' + route.path);
  }

  this.multipartRoutes.push({method: route.method, path: route.path});
};

EditionRegistry.prototype.getMultipartRoutes = function() {
  return this.multipartRoutes.map(route => Object.assign({}, route));
};

EditionRegistry.prototype.isMultipartRoute = function(method, path) {
  return this.multipartRoutes.some(route => route.method === method && route.path === path);
};

/*
  Middleware handed to registerRoute is mounted as a sibling of the router:

    app.use(path, ...middleware, router)

  which makes each middleware its own layer matching `path` as a prefix, not a
  gate on the router's own routes. At path '/' that prefix is every URL, so a
  gate registered there answers for every route mounted after it and for the
  404 handler - the router it was meant to protect is beside the point.

  Two editions registered an admin gate exactly that way. The damage was
  invisible to an admin and total for everyone else: a plain employee got 303
  to '/' on the premium pages, and a mistyped URL redirected instead of
  rendering the not-found page. Refused here rather than in a review, since the
  correct form - the prefix the router actually serves - is what every other
  registration in both editions already uses.
*/
const requireMountableMiddleware = function(route, middleware) {
  if (route.path === '/' && middleware.length) {
    throw new Error(
      'Edition route ' + (route.name || route.path) + ' mounts middleware at "/", '
      + 'which applies it to every request rather than to its own router. '
      + 'Register it under the path prefix its router serves.'
    );
  }
};

EditionRegistry.prototype.registerRoute = function(route) {
  if (!route || !route.path || !route.router) {
    throw new Error('Edition route requires path and router');
  }

  requireMountableMiddleware(route, [].concat(route.middleware || []));

  this.routes.push({
    name       : route.name || route.path,
    path       : route.path,
    placement  : route.placement === 'public' ? 'public' : 'authenticated',
    middleware : route.middleware || [],
    router     : route.router,
  });
};

EditionRegistry.prototype.getRoutes = function() {
  return this.routes.map(cloneRoute);
};

EditionRegistry.prototype.applyRoutes = function(app, options) {
  const placement = options && options.placement;

  this.routes
  .filter(function(route) {
    return !placement || route.placement === placement;
  })
  .forEach(function(route) {
    const middleware = Array.isArray(route.middleware)
      ? route.middleware
      : [route.middleware];

    app.use.apply(app, [route.path].concat(middleware).concat(route.router));
  });
};

EditionRegistry.prototype.registerScheduler = function(scheduler) {
  if (!scheduler || !scheduler.name || typeof scheduler.start !== 'function') {
    throw new Error('Edition scheduler requires name and start function');
  }

  this.schedulers.push({
    name    : scheduler.name,
    start   : scheduler.start,
    runOnce : typeof scheduler.runOnce === 'function' ? scheduler.runOnce : null,
  });
};

EditionRegistry.prototype.getSchedulers = function() {
  return this.schedulers.map(cloneScheduler);
};

EditionRegistry.prototype.startSchedulers = function(context) {
  return this.schedulers.map(function(scheduler) {
    return {
      name   : scheduler.name,
      handle : scheduler.start(context || {}),
    };
  });
};

EditionRegistry.prototype.runSchedulerOnce = function(name, context) {
  const scheduler = this.schedulers.find(s => s.name === name);

  if (!scheduler) {
    return Promise.reject(new Error('Scheduler not found: ' + name));
  }

  if (!scheduler.runOnce) {
    return Promise.reject(new Error('Scheduler does not support runOnce: ' + name));
  }

  return Promise.resolve(scheduler.runOnce(context || {}));
};

EditionRegistry.prototype.registerNavigationItem = function(item) {
  if (!item || !item.feature || !item.name || !item.path || !item.labelKey || !item.location) {
    throw new Error('Edition navigation item requires feature, name, path, labelKey, and location');
  }

  this.navigationItems.push({
    feature   : item.feature,
    name      : item.name,
    path      : item.path,
    labelKey  : item.labelKey,
    location  : item.location,
    icon      : item.icon || null,
    badgeId   : item.badgeId || null,
    order     : item.order || 0,
    adminOnly : !!item.adminOnly,
  });
};

EditionRegistry.prototype.getNavigationItems = function(options) {
  const opts = options || {};

  return this.navigationItems
    .filter(item => !opts.location || item.location === opts.location)
    .filter(item => opts.enabledOnly === false || features.isEnabled(item.feature))
    .sort((a, b) => a.order - b.order)
    .map(cloneNavigationItem);
};

EditionRegistry.prototype.registerNotificationProvider = function(provider) {
  if (!provider || !provider.feature || !provider.type || typeof provider.fetch !== 'function') {
    throw new Error('Edition notification provider requires feature, type, and fetch function');
  }

  this.notificationProviders.push({
    feature        : provider.feature,
    type           : provider.type,
    translationKey : provider.translationKey || provider.type,
    link           : provider.link || null,
    badgeId        : provider.badgeId || null,
    fetch          : provider.fetch,
    order          : provider.order || 0,
  });
};

EditionRegistry.prototype.getNotificationProviders = function(options) {
  const opts = options || {};

  return this.notificationProviders
    .filter(provider => opts.enabledOnly === false || features.isEnabled(provider.feature))
    .sort((a, b) => a.order - b.order)
    .map(cloneNotificationProvider);
};

EditionRegistry.prototype.registerDiagnostic = function(diagnostic) {
  if (!diagnostic || !diagnostic.name || typeof diagnostic.collect !== 'function') {
    throw new Error('Edition diagnostic requires name and collect function');
  }

  this.diagnostics.push({
    name    : diagnostic.name,
    collect : diagnostic.collect,
  });
};

EditionRegistry.prototype.getDiagnostics = function() {
  return this.diagnostics.map(cloneDiagnostic);
};

EditionRegistry.prototype.collectDiagnostics = function(context) {
  return Promise.all(this.diagnostics.map(diagnostic =>
    Promise.resolve(diagnostic.collect(context || {}))
      .then(result => Object.assign({ name : diagnostic.name }, result || {}))
  ));
};

EditionRegistry.prototype.registerViewPath = function(viewPath) {
  if (!viewPath || typeof viewPath !== 'string') {
    throw new Error('Edition view path requires a string path');
  }

  if (this.viewPaths.indexOf(viewPath) === -1) {
    this.viewPaths.push(viewPath);
  }
};

EditionRegistry.prototype.getViewPaths = function() {
  return this.viewPaths.map(cloneViewPath);
};

EditionRegistry.prototype.applyViewPaths = function(app, basePaths) {
  const normalizedBasePaths = Array.isArray(basePaths)
    ? basePaths.slice()
    : [basePaths];
  const paths = normalizedBasePaths
    .concat(this.viewPaths)
    .filter(Boolean)
    .filter(function(viewPath, index, allPaths) {
      return allPaths.indexOf(viewPath) === index;
    });

  app.set('views', paths);
  return paths.slice();
};

EditionRegistry.prototype.registerEmailTemplatePath = function(emailTemplatePath) {
  if (!emailTemplatePath || typeof emailTemplatePath !== 'string') {
    throw new Error('Edition email template path requires a string path');
  }

  if (this.emailTemplatePaths.indexOf(emailTemplatePath) === -1) {
    this.emailTemplatePaths.push(emailTemplatePath);
  }
};

EditionRegistry.prototype.getEmailTemplatePaths = function() {
  return this.emailTemplatePaths.map(cloneEmailTemplatePath);
};

EditionRegistry.prototype.registerPartialTemplatePath = function(partialTemplatePath) {
  if (!partialTemplatePath || typeof partialTemplatePath !== 'string') {
    throw new Error('Edition partial template path requires a string path');
  }

  if (this.partialTemplatePaths.indexOf(partialTemplatePath) === -1) {
    this.partialTemplatePaths.push(partialTemplatePath);
  }
};

EditionRegistry.prototype.getPartialTemplatePaths = function() {
  return this.partialTemplatePaths.map(clonePartialTemplatePath);
};

EditionRegistry.prototype.registerDbModelPath = function(dbModelPath) {
  if (!dbModelPath || typeof dbModelPath !== 'string') {
    throw new Error('Edition DB model path requires a string path');
  }

  if (this.dbModelPaths.indexOf(dbModelPath) === -1) {
    this.dbModelPaths.push(dbModelPath);
  }
};

EditionRegistry.prototype.getDbModelPaths = function() {
  return this.dbModelPaths.map(cloneDbModelPath);
};

EditionRegistry.prototype.registerLocalePath = function(localePath) {
  if (!localePath || typeof localePath !== 'string') {
    throw new Error('Edition locale path requires a string path');
  }

  if (this.localePaths.indexOf(localePath) === -1) {
    this.localePaths.push(localePath);
  }
};

EditionRegistry.prototype.getLocalePaths = function() {
  return this.localePaths.map(cloneLocalePath);
};

EditionRegistry.prototype.registerMigrationPath = function(migrationPath) {
  if (!migrationPath || typeof migrationPath !== 'string') {
    throw new Error('Edition migration path requires a string path');
  }

  if (this.migrationPaths.indexOf(migrationPath) === -1) {
    this.migrationPaths.push(migrationPath);
  }
};

EditionRegistry.prototype.getMigrationPaths = function() {
  return this.migrationPaths.map(cloneMigrationPath);
};

EditionRegistry.prototype.registerDbAssociation = function(dbAssociation) {
  if (!dbAssociation || !dbAssociation.name || typeof dbAssociation.associate !== 'function') {
    throw new Error('Edition DB association requires name and associate function');
  }

  this.dbAssociations.push({
    name      : dbAssociation.name,
    associate : dbAssociation.associate,
  });
};

EditionRegistry.prototype.getDbAssociations = function() {
  return this.dbAssociations.map(cloneDbAssociation);
};

EditionRegistry.prototype.applyDbAssociations = function(models) {
  this.dbAssociations.forEach(function(dbAssociation) {
    dbAssociation.associate(models);
  });
};

EditionRegistry.prototype.registerLeaveEventDispatcher = function(dispatcher) {
  if (!dispatcher || typeof dispatcher.dispatch !== 'function') {
    throw new Error('Leave event dispatcher must have a dispatch function');
  }

  this._leaveEventDispatcher = dispatcher;
  return this;
};

EditionRegistry.prototype.getLeaveEventDispatcher = function() {
  return this._leaveEventDispatcher || null;
};

EditionRegistry.prototype.registerLeaveValidator = function(validator) {
  if (!validator || typeof validator.validate !== 'function') {
    throw new Error('Leave validator must have a validate function');
  }

  this._leaveValidator = validator;
  return this;
};

EditionRegistry.prototype.getLeaveValidator = function() {
  return this._leaveValidator || null;
};

EditionRegistry.prototype.registerSupervisedDepartmentProvider = function(provider) {
  if (!provider || typeof provider.getDepartmentIds !== 'function') {
    throw new Error('Supervised department provider must have getDepartmentIds');
  }

  this._supervisedDepartmentProvider = provider;
  return this;
};

EditionRegistry.prototype.getSupervisedDepartmentProvider = function() {
  return this._supervisedDepartmentProvider || null;
};

EditionRegistry.prototype.registerSsoProvider = function(provider) {
  if (!provider || typeof provider !== 'object') {
    throw new Error('SSO provider must be an object');
  }

  this._ssoProvider = provider;
  return this;
};

EditionRegistry.prototype.getSsoProvider = function() {
  return this._ssoProvider || null;
};

module.exports = EditionRegistry;
