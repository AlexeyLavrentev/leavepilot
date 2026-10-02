'use strict';

const edition = require('./edition');
const features = require('./features');
const teamViewCache = require('./cache/team_view_cache');
const deliveryOutbox = require('./model/delivery_outbox');
const packageInfo = require('../package.json');

const SENSITIVE_KEY_PATTERN = /(?:raw|signature|secret|password|token|private.?key|public.?key|authorization|cookie)/i;

function sanitize(value) {
  if (Array.isArray(value)) {
    return value.map(sanitize);
  }

  if (value && typeof value === 'object') {
    return Object.keys(value).reduce((result, key) => {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        return result;
      }

      result[key] = sanitize(value[key]);
      return result;
    }, {});
  }

  return value;
}

function summarizeEditionInfo(info) {
  const editionInfo = info || {};

  return {
    initialized: !!editionInfo.initialized,
    premium: {
      loaded: !!(editionInfo.premium && editionInfo.premium.loaded),
      moduleName: editionInfo.premium && editionInfo.premium.moduleName || null,
      required: !!(editionInfo.premium && editionInfo.premium.required),
    },
    counts: {
      routes: (editionInfo.routes || []).length,
      schedulers: (editionInfo.schedulers || []).length,
      navigationItems: (editionInfo.navigationItems || []).length,
      notificationProviders: (editionInfo.notificationProviders || []).length,
      diagnostics: (editionInfo.diagnostics || []).length,
      viewPaths: (editionInfo.viewPaths || []).length,
      emailTemplatePaths: (editionInfo.emailTemplatePaths || []).length,
      partialTemplatePaths: (editionInfo.partialTemplatePaths || []).length,
      dbModelPaths: (editionInfo.dbModelPaths || []).length,
      localePaths: (editionInfo.localePaths || []).length,
      migrationPaths: (editionInfo.migrationPaths || []).length,
      dbAssociations: (editionInfo.dbAssociations || []).length,
    },
    routes: (editionInfo.routes || []).map(route => ({
      name: route.name,
      path: route.path,
    })),
    navigationItems: (editionInfo.navigationItems || []).map(item => ({
      name: item.name,
      feature: item.feature,
      location: item.location,
    })),
    notificationProviders: (editionInfo.notificationProviders || []).map(provider => ({
      type: provider.type,
      feature: provider.feature,
    })),
    dbAssociations: (editionInfo.dbAssociations || []).map(dbAssociation => ({
      name: dbAssociation.name,
    })),
  };
}

/*
  Default delivery counter (D-08): counts pending and failed outbox records
  through the shared model registry. The registry is required lazily so
  requiring this module never constructs the database layer on its own; the
  counts below connect on demand, and any rejection is mapped to null fields
  by the caller below.
*/
const defaultDeliveryCounts = async () => {
  const models = require('./model/db');

  const pending = await models.DeliveryOutbox.count({
    where: {status: deliveryOutbox.STATUS_PENDING},
  });
  const failed = await models.DeliveryOutbox.count({
    where: {status: deliveryOutbox.STATUS_FAILED},
  });

  return {pending, failed};
};

async function collect(options) {
  const deps = options || {};
  const editionModule = deps.edition || edition;
  const featuresModule = deps.features || features;
  const cacheModule = deps.cache || teamViewCache;
  const environment = deps.env || process.env;
  const editionInfo = editionModule.getInfo();
  const moduleDiagnostics = typeof editionModule.collectDiagnostics === 'function'
    ? await editionModule.collectDiagnostics()
    : [];

  // Cache-policy visibility (D-01/D-05): the snapshot reports WHICH policy is
  // active and the store kind only. The section is built from exactly these
  // two fields rather than passing the status object through, because the
  // sanitize path strips secret-looking keys but not connection details such
  // as host or port.
  const cacheStatus = typeof cacheModule.getStatus === 'function'
    ? cacheModule.getStatus()
    : null;

  // Delivery backlog visibility (D-08, MUT-02): the snapshot reports the
  // outbox backlog as exactly two counts. The section is built from exactly
  // these two integer fields rather than passing counting results through,
  // because record data (last_error text, payload fragments, recipient
  // references) must never reach an operator surface — the sanitize pass is
  // defense in depth, not the primary gate. A counting failure (database
  // unavailable) maps to null fields: diagnostics must never throw.
  const deliveryCounter = typeof deps.deliveryCounts === 'function'
    ? deps.deliveryCounts
    : defaultDeliveryCounts;

  let delivery;
  try {
    const counts = (await deliveryCounter()) || {};
    delivery = {
      pending: typeof counts.pending === 'number' ? counts.pending : null,
      failed : typeof counts.failed === 'number' ? counts.failed : null,
    };
  } catch {
    // Pitfall 11: an unavailable database reports null counts, not an error.
    delivery = {pending: null, failed: null};
  }

  return sanitize({
    generatedAt: new Date().toISOString(),
    application: {
      name: packageInfo.name,
      version: packageInfo.version,
      revision: environment.APP_REVISION || environment.GIT_COMMIT || null,
    },
    runtime: {
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      uptimeSeconds: Math.floor(process.uptime()),
    },
    environment: {
      nodeEnv: environment.NODE_ENV || 'development',
    },
    cache: {
      mode: cacheStatus && cacheStatus.mode || null,
      store: cacheStatus && cacheStatus.store || null,
    },
    delivery,
    license: featuresModule.getLicenseStatus(),
    enabledFeatures: featuresModule.getEnabledMap(),
    edition: summarizeEditionInfo(editionInfo),
    moduleDiagnostics,
  });
}

module.exports = {
  collect,
  sanitize,
  summarizeEditionInfo,
};
