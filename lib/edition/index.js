'use strict';

const EditionRegistry = require('./registry');
const community = require('./community');
const premiumLoader = require('./premium_loader');
const logger = require('../middleware/request_logger');

let registry = new EditionRegistry();

let initialized = false;
let initializing = false;
let communityInfo = null;
let premiumInfo = null;

const initialize = context => {
  if (initialized || initializing) {
    return {
      community: communityInfo,
      premium: premiumInfo,
    };
  }

  const effectiveContext = context || {};
  const previousRegistry = registry;
  const candidateRegistry = new EditionRegistry();

  registry = candidateRegistry;
  initializing = true;
  try {
    communityInfo = community.register({
      registry: candidateRegistry,
      context: effectiveContext,
    });
    premiumInfo = premiumLoader.load({
      registry: candidateRegistry,
      context: effectiveContext,
      logger: effectiveContext.logger,
    });
    initialized = true;
  } catch (err) {
    registry = previousRegistry;
    communityInfo = null;
    premiumInfo = null;
    initialized = false;
    throw err;
  } finally {
    initializing = false;
  }

  return {
    community: communityInfo,
    premium: premiumInfo,
  };
};

const registerRoutes = (app, context) => {
  initialize(context);
  registry.applyRoutes(app, { placement: 'authenticated' });
};

const registerPublicRoutes = (app, context) => {
  initialize(context);
  registry.applyRoutes(app, { placement: 'public' });
};

const startSchedulers = context => {
  initialize(context);
  return registry.startSchedulers(context);
};

const getNavigationItems = (options, context) => {
  initialize(context);
  return registry.getNavigationItems(options);
};

const getNotificationProviders = (options, context) => {
  initialize(context);
  return registry.getNotificationProviders(options);
};

const collectDiagnostics = context => {
  initialize(context);
  return registry.collectDiagnostics(context);
};

const getViewPaths = context => {
  initialize(context);
  return registry.getViewPaths();
};

const applyViewPaths = (app, basePaths, context) => {
  initialize(context);
  return registry.applyViewPaths(app, basePaths);
};

const getEmailTemplatePaths = context => {
  initialize(context);
  return registry.getEmailTemplatePaths();
};

const getPartialTemplatePaths = context => {
  initialize(context);
  return registry.getPartialTemplatePaths();
};

const getDbModelPaths = context => {
  initialize(context);
  return registry.getDbModelPaths();
};

const getLocalePaths = context => {
  initialize(context);
  return registry.getLocalePaths();
};

const getMigrationPaths = context => {
  initialize(context);
  return registry.getMigrationPaths();
};

const isMultipartRoute = (method, path, context) => {
  initialize(context || {});
  return registry.isMultipartRoute(method, path);
};

const getDbAssociations = context => {
  initialize(context);
  return registry.getDbAssociations();
};

const applyDbAssociations = (models, context) => {
  initialize(context);
  registry.applyDbAssociations(models);
};

const getInfo = () => ({
  initialized,
  community: communityInfo,
  premium: premiumInfo,
  routes: registry.getRoutes().map(route => ({
    name: route.name,
    path: route.path,
  })),
  schedulers: registry.getSchedulers().map(scheduler => ({
    name: scheduler.name,
  })),
  navigationItems: registry.getNavigationItems({enabledOnly: false}).map(item => ({
    name: item.name,
    feature: item.feature,
    location: item.location,
  })),
  notificationProviders: registry.getNotificationProviders({enabledOnly: false}).map(provider => ({
    type: provider.type,
    feature: provider.feature,
  })),
  diagnostics: registry.getDiagnostics().map(diagnostic => ({
    name: diagnostic.name,
  })),
  deliveryExecutors: registry.getDeliveryExecutors().map(executor => ({
    deliveryType: executor.deliveryType,
  })),
  viewPaths: registry.getViewPaths(),
  emailTemplatePaths: registry.getEmailTemplatePaths(),
  partialTemplatePaths: registry.getPartialTemplatePaths(),
  dbModelPaths: registry.getDbModelPaths(),
  localePaths: registry.getLocalePaths(),
  migrationPaths: registry.getMigrationPaths(),
  dbAssociations: registry.getDbAssociations().map(dbAssociation => ({
    name: dbAssociation.name,
  })),
});

const dispatchLeaveEvent = ({type, leave, context}) => {
  initialize(context || {});
  const dispatcher = registry.getLeaveEventDispatcher();

  if (!dispatcher) {
    return;
  }

  try {
    const result = dispatcher.dispatch({type, leave});
    if (result && typeof result.catch === 'function') {
      result.catch(function(error) {
        logger.error('leave_event_dispatcher_error', {
          message: error && error.message || String(error),
          stack  : error && error.stack,
        });
      });
    }
  } catch (error) {
    logger.error('leave_event_dispatcher_error', {
      message: error && error.message || String(error),
      stack  : error && error.stack,
    });
  }
};

const getSupervisedDepartmentIds = ({user, context}) => {
  initialize(context || {});

  const provider = registry.getSupervisedDepartmentProvider();

  if (!provider) {
    return Promise.resolve([]);
  }

  try {
    const result = provider.getDepartmentIds({user});

    if (result && typeof result.then === 'function') {
      return result.catch(function(error) {
        logger.error('supervised_department_provider_error', {
          message: error && error.message || String(error),
          stack  : error && error.stack,
        });
        return [];
      });
    }

    return Promise.resolve(result || []);
  } catch (error) {
    logger.error('supervised_department_provider_error', {
      message: error && error.message || String(error),
      stack  : error && error.stack,
    });
    return Promise.resolve([]);
  }
};

module.exports = {
  applyDbAssociations,
  applyViewPaths,
  collectDiagnostics,
  dispatchLeaveEvent,
  getDbAssociations,
  getDbModelPaths,
  getEmailTemplatePaths,
  getInfo,
  getLocalePaths,
  getMigrationPaths,
  isMultipartRoute,
  getNavigationItems,
  getNotificationProviders,
  getPartialTemplatePaths,
  getRegistry: () => registry,
  getSupervisedDepartmentIds,
  getViewPaths,
  initialize,
  registerPublicRoutes,
  registerRoutes,
  startSchedulers,
};
