'use strict';

var expect = require('chai').expect;
var EditionRegistry = require('../../lib/edition/registry');
var features = require('../../lib/features');

describe('Edition registry', function() {
  var originalFeatureTimeBalance;
  var originalFeaturesEnv = {};

  // Both feature-switch generations are cleared: the CI coverage contour
  // exports LEAVEPILOT_FEATURES=all, and a scaffold that only cleared the
  // legacy TIMEOFF_FEATURES name leaked the canonical one into these specs.
  var FEATURES_ENV_KEYS = ['TIMEOFF_FEATURES', 'LEAVEPILOT_FEATURES'];

  beforeEach(function() {
    originalFeatureTimeBalance = process.env.FEATURE_TIME_BALANCE;
    FEATURES_ENV_KEYS.forEach(function(key) {
      originalFeaturesEnv[key] = process.env[key];
      delete process.env[key];
    });
    delete process.env.FEATURE_TIME_BALANCE;
    features.registerFeature('time_balance');
  });

  afterEach(function() {
    if (typeof originalFeatureTimeBalance === 'undefined') {
      delete process.env.FEATURE_TIME_BALANCE;
    } else {
      process.env.FEATURE_TIME_BALANCE = originalFeatureTimeBalance;
    }

    FEATURES_ENV_KEYS.forEach(function(key) {
      if (typeof originalFeaturesEnv[key] === 'undefined') {
        delete process.env[key];
      } else {
        process.env[key] = originalFeaturesEnv[key];
      }
    });
  });

  it('applies registered routes to express app', function() {
    var registry = new EditionRegistry();
    var calls = [];
    var middleware = function(req, res, next) { next(); };
    var router = function(req, res) { res.end(); };

    registry.registerRoute({
      name       : 'premium-page',
      path       : '/premium/',
      middleware : [middleware],
      router     : router,
    });

    registry.applyRoutes({
      use: function() {
        calls.push(Array.prototype.slice.call(arguments));
      },
    });

    expect(calls.length).to.equal(1);
    expect(calls[0][0]).to.equal('/premium/');
    expect(calls[0][1]).to.equal(middleware);
    expect(calls[0][2]).to.equal(router);
  });

  it('mounts public and authenticated extension routes separately', function() {
    var registry = new EditionRegistry();
    var publicCalls = [];
    var authenticatedCalls = [];
    var publicRouter = function() {};
    var authenticatedRouter = function() {};

    registry.registerRoute({
      name      : 'integration-api',
      path      : '/integration/v1/',
      placement : 'public',
      router    : publicRouter,
    });
    registry.registerRoute({
      name   : 'premium-page',
      path   : '/premium/',
      router : authenticatedRouter,
    });

    registry.applyRoutes({
      use: function() {
        publicCalls.push(Array.prototype.slice.call(arguments));
      },
    }, { placement: 'public' });
    registry.applyRoutes({
      use: function() {
        authenticatedCalls.push(Array.prototype.slice.call(arguments));
      },
    }, { placement: 'authenticated' });

    expect(publicCalls.length).to.equal(1);
    expect(publicCalls[0][0]).to.equal('/integration/v1/');
    expect(publicCalls[0][1]).to.equal(publicRouter);
    expect(authenticatedCalls.length).to.equal(1);
    expect(authenticatedCalls[0][0]).to.equal('/premium/');
    expect(authenticatedCalls[0][1]).to.equal(authenticatedRouter);
  });

  it('starts registered schedulers', function() {
    var registry = new EditionRegistry();
    var startedWith;

    registry.registerScheduler({
      name: 'premium-scheduler',
      start: function(context) {
        startedWith = context;
        return { stop: function() {} };
      },
    });

    var handles = registry.startSchedulers({
      models: { connected: true },
    });

    expect(startedWith.models.connected).to.equal(true);
    expect(handles.length).to.equal(1);
    expect(handles[0].name).to.equal('premium-scheduler');
    expect(handles[0].handle.stop).to.be.a('function');
  });

  it('rejects incomplete extension contracts', function() {
    var registry = new EditionRegistry();

    expect(function() {
      registry.registerRoute({ path: '/broken/' });
    }).to.throw(/path and router/);

    expect(function() {
      registry.registerScheduler({ name: 'broken' });
    }).to.throw(/name and start/);
  });

  it('returns copies of registered route and scheduler contracts', function() {
    var registry = new EditionRegistry();
    var router = function() {};

    registry.registerRoute({
      name   : 'premium-page',
      path   : '/premium/',
      router : router,
    });
    registry.registerScheduler({
      name  : 'premium-scheduler',
      start : function() {},
    });

    var routes = registry.getRoutes();
    var schedulers = registry.getSchedulers();

    routes[0].name = 'mutated-route';
    schedulers[0].name = 'mutated-scheduler';

    expect(registry.getRoutes()[0].name).to.equal('premium-page');
    expect(registry.getSchedulers()[0].name).to.equal('premium-scheduler');
  });

  it('registers exact multipart POST routes without exposing mutable state', function() {
    var registry = new EditionRegistry();

    registry.registerMultipartRoute({method: 'POST', path: '/settings/import/'});

    expect(registry.isMultipartRoute('POST', '/settings/import/')).to.equal(true);
    expect(registry.isMultipartRoute('POST', '/settings/import')).to.equal(false);
    expect(registry.isMultipartRoute('GET', '/settings/import/')).to.equal(false);

    var routes = registry.getMultipartRoutes();
    routes[0].path = '/mutated/';
    expect(registry.getMultipartRoutes()[0].path).to.equal('/settings/import/');
  });

  it('rejects invalid and duplicate multipart route declarations', function() {
    var registry = new EditionRegistry();

    [
      null,
      {method: 'GET', path: '/settings/import/'},
      {method: 'POST', path: 'settings/import/'},
      {method: 'POST', path: '/settings/import'},
    ].forEach(function(route) {
      expect(function() { registry.registerMultipartRoute(route); }).to.throw(/multipart route requires/);
    });

    registry.registerMultipartRoute({method: 'POST', path: '/settings/import/'});
    expect(function() {
      registry.registerMultipartRoute({method: 'POST', path: '/settings/import/'});
    }).to.throw(/already registered/);
  });

  it('validates and filters navigation items by feature', function() {
    var registry = new EditionRegistry();

    expect(function() {
      registry.registerNavigationItem({name: 'broken'});
    }).to.throw(/navigation item requires/);

    registry.registerNavigationItem({
      feature  : 'time_balance',
      name     : 'time-balance',
      path     : '/time-balance/',
      labelKey : 'nav.timeBalance',
      location : 'primary',
      order    : 20,
    });
    registry.registerNavigationItem({
      feature  : 'integration_api',
      name     : 'integration-api',
      path     : '/settings/company/integration-api/',
      labelKey : 'nav.apiConfig',
      location : 'settings',
      order    : 10,
    });

    expect(registry.getNavigationItems().length).to.equal(0);

    process.env.FEATURE_TIME_BALANCE = 'true';

    var enabledItems = registry.getNavigationItems();

    expect(enabledItems.length).to.equal(1);
    expect(enabledItems[0].name).to.equal('time-balance');

    enabledItems[0].name = 'mutated';

    expect(registry.getNavigationItems()[0].name).to.equal('time-balance');
    expect(registry.getNavigationItems({location: 'settings', enabledOnly: false})[0].name)
      .to.equal('integration-api');
  });

  it('validates and filters notification providers without executing disabled providers', function() {
    var registry = new EditionRegistry();
    var fetchCalls = 0;
    var fetch = function() {
      fetchCalls += 1;
      return Promise.resolve([]);
    };

    expect(function() {
      registry.registerNotificationProvider({type: 'broken'});
    }).to.throw(/notification provider requires/);

    registry.registerNotificationProvider({
      feature : 'time_balance',
      type    : 'pending_time_balance_request',
      badgeId : 'time-balance-nav-badge',
      fetch   : fetch,
    });

    expect(registry.getNotificationProviders().length).to.equal(0);
    expect(fetchCalls).to.equal(0);

    process.env.FEATURE_TIME_BALANCE = 'true';

    var providers = registry.getNotificationProviders();
    providers[0].type = 'mutated';

    expect(providers.length).to.equal(1);
    expect(providers[0].badgeId).to.equal('time-balance-nav-badge');
    expect(registry.getNotificationProviders()[0].type).to.equal('pending_time_balance_request');
  });

  it('collects safe diagnostic entries', async function() {
    var registry = new EditionRegistry();

    expect(function() {
      registry.registerDiagnostic({name: 'broken'});
    }).to.throw(/diagnostic requires/);

    registry.registerDiagnostic({
      name: 'license',
      collect: function(context) {
        return {
          status: context.status,
          secret: undefined,
        };
      },
    });

    var diagnostics = await registry.collectDiagnostics({status: 'valid'});

    expect(diagnostics).to.deep.equal([{
      name: 'license',
      status: 'valid',
      secret: undefined,
    }]);

    var registered = registry.getDiagnostics();
    registered[0].name = 'mutated';

    expect(registry.getDiagnostics()[0].name).to.equal('license');
  });

  it('registers unique view paths and applies them to express app', function() {
    var registry = new EditionRegistry();
    var appViews;

    registry.registerViewPath('/premium/views');
    registry.registerViewPath('/premium/views');

    expect(function() {
      registry.registerViewPath({});
    }).to.throw(/view path requires/);

    var applied = registry.applyViewPaths({
      set: function(key, value) {
        if (key === 'views') {
          appViews = value;
        }
      },
    }, ['/core/views', '/premium/views']);

    expect(registry.getViewPaths()).to.deep.equal(['/premium/views']);
    expect(applied).to.deep.equal(['/core/views', '/premium/views']);
    expect(appViews).to.deep.equal(['/core/views', '/premium/views']);
  });

  it('registers unique email template paths', function() {
    var registry = new EditionRegistry();

    registry.registerEmailTemplatePath('/premium/email');
    registry.registerEmailTemplatePath('/premium/email');

    expect(function() {
      registry.registerEmailTemplatePath([]);
    }).to.throw(/email template path requires/);

    expect(registry.getEmailTemplatePaths()).to.deep.equal(['/premium/email']);
  });

  it('registers unique partial template paths', function() {
    var registry = new EditionRegistry();

    registry.registerPartialTemplatePath('/premium/partials');
    registry.registerPartialTemplatePath('/premium/partials');

    expect(function() {
      registry.registerPartialTemplatePath(null);
    }).to.throw(/partial template path requires/);

    expect(registry.getPartialTemplatePaths()).to.deep.equal(['/premium/partials']);
  });

  it('registers unique DB model paths', function() {
    var registry = new EditionRegistry();

    registry.registerDbModelPath('/premium/db');
    registry.registerDbModelPath('/premium/db');

    expect(function() {
      registry.registerDbModelPath(1);
    }).to.throw(/DB model path requires/);

    expect(registry.getDbModelPaths()).to.deep.equal(['/premium/db']);
  });

  it('registers unique locale paths', function() {
    var registry = new EditionRegistry();

    registry.registerLocalePath('/premium/locales');
    registry.registerLocalePath('/premium/locales');

    expect(function() {
      registry.registerLocalePath(false);
    }).to.throw(/locale path requires/);

    expect(registry.getLocalePaths()).to.deep.equal(['/premium/locales']);
  });

  it('registers unique migration paths', function() {
    var registry = new EditionRegistry();

    registry.registerMigrationPath('/premium/migrations');
    registry.registerMigrationPath('/premium/migrations');

    expect(function() {
      registry.registerMigrationPath({});
    }).to.throw(/migration path requires/);

    expect(registry.getMigrationPaths()).to.deep.equal(['/premium/migrations']);
  });

  it('registers and applies DB associations', function() {
    var registry = new EditionRegistry();
    var associated = [];

    expect(function() {
      registry.registerDbAssociation({name: 'broken'});
    }).to.throw(/DB association requires/);

    registry.registerDbAssociation({
      name: 'premium-association',
      associate: function(models) {
        associated.push(models.Company.name);
      },
    });

    var associations = registry.getDbAssociations();
    associations[0].name = 'mutated';

    registry.applyDbAssociations({
      Company: {name: 'Company'},
    });

    expect(registry.getDbAssociations()[0].name).to.equal('premium-association');
    expect(associated).to.deep.equal(['Company']);
  });

  it('registers a leave event dispatcher with validation', function() {
    var registry = new EditionRegistry();

    expect(function() {
      registry.registerLeaveEventDispatcher({broken: true});
    }).to.throw(/dispatch function/);

    expect(function() {
      registry.registerLeaveEventDispatcher(null);
    }).to.throw(/dispatch function/);

    expect(registry.getLeaveEventDispatcher()).to.equal(null);

    var dispatcher = {dispatch: function() {}};
    var result = registry.registerLeaveEventDispatcher(dispatcher);

    expect(result).to.equal(registry);
    expect(registry.getLeaveEventDispatcher()).to.equal(dispatcher);
  });
});
