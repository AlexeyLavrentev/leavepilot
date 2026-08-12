'use strict';

const path = require('path');
const config = require('../config');
const envResolver = require('../env_resolver');
const features = require('../features');
const {isCommercialEdition} = require('./commercial_mode');

const resolveModuleName = () =>
  envResolver.resolve('PREMIUM_MODULE')
  || config.get('premium_module')
  || '';

const parseBoolean = value => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    return ['true', '1', 'yes', 'on'].indexOf(value.toLowerCase()) !== -1;
  }

  return !!value;
};

const isRequired = () => {
  if (typeof envResolver.resolve('PREMIUM_MODULE_REQUIRED') !== 'undefined') {
    return parseBoolean(envResolver.resolve('PREMIUM_MODULE_REQUIRED'));
  }

  return parseBoolean(config.get('premium_module_required'));
};

const requirePremiumModule = moduleName => {
  if (moduleName.indexOf('.') === 0 || moduleName.indexOf('/') === 0) {
    return require(path.resolve(process.cwd(), moduleName));
  }

  return require(moduleName);
};

const createPremiumContext = context => {
  const coreRoot = path.resolve(__dirname, '..', '..');
  const providedContext = context || {};

  return Object.assign({}, providedContext, {
    coreRoot,
    coreRequire: modulePath => require(path.join(coreRoot, 'lib', modulePath)),
    coreRequirePackage: packageName => require(packageName),
  });
};

const isMissingRequestedModule = (error, moduleName) => (
  error
  && error.code === 'MODULE_NOT_FOUND'
  && (
    error.message.indexOf("'" + moduleName + "'") !== -1
    || error.message.indexOf('"' + moduleName + '"') !== -1
  )
);

const load = ({registry, context, logger}) => {
  const moduleName = resolveModuleName();
  const effectiveLogger = logger || console;
  const required = isRequired();

  if (!moduleName) {
    if (required) {
      throw new Error('Premium module required but LEAVEPILOT_PREMIUM_MODULE is not configured.');
    }

    return {
      loaded: false,
      moduleName: null,
    };
  }

  let premiumModule;

  try {
    premiumModule = requirePremiumModule(moduleName);
  } catch (error) {
    if (isMissingRequestedModule(error, moduleName)) {
      if (required) {
        throw new Error('Premium module required but not installed: ' + moduleName);
      }

      effectiveLogger.warn('Premium module not installed: ' + moduleName);
      return {
        loaded: false,
        moduleName,
        required: false,
      };
    }

    throw error;
  }

  if (required || isCommercialEdition()) {
    features.assertCommercialLicense();
  }

  const premiumContext = createPremiumContext(context);

  if (typeof premiumModule === 'function') {
    premiumModule({registry, context: premiumContext});
  } else if (premiumModule && typeof premiumModule.register === 'function') {
    premiumModule.register({registry, context: premiumContext});
  } else {
    throw new Error('Premium module must export function or register({registry, context})');
  }

  return {
    loaded: true,
    moduleName,
    required,
  };
};

module.exports = {
  createPremiumContext,
  isRequired,
  load,
  resolveModuleName,
};
