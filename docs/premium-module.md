# Premium Module Contract

The community application can optionally load a private premium module at
startup. This keeps the source-available core runnable on its own while giving the
commercial build one stable extension point.

## Configuration

Set the module name or path with one of these values:

```env
TIMEOFF_PREMIUM_MODULE=@your-company/timeoff-premium
TIMEOFF_PREMIUM_MODULE_REQUIRED=true
```

or in `config/app.json`:

```json
{
  "premium_module": "@your-company/timeoff-premium",
  "premium_module_required": true
}
```

If the value is empty, the app runs as the community edition. If the configured
module is not installed, the app logs a warning and continues without premium
extensions.

In community mode, bundled premium routes, DB models, templates, partials, email
templates, cache helpers, DB migrations, and DB associations are not loaded.
Keep this boundary covered by `t/unit/edition_community_boundary.js` when
adding new premium surfaces.

During local development, point the app at the private premium repository:

```env
TIMEOFF_PREMIUM_MODULE=/path/to/timeoff-premium
```

Use it together with a license that enables the corresponding features.
Commercial images should point `TIMEOFF_PREMIUM_MODULE` to the private package
name or the installed package path.

For commercial images, set `TIMEOFF_PREMIUM_MODULE_REQUIRED=true` or
`premium_module_required=true`. In that mode, startup fails when the configured
premium module path is empty or the module is missing. In production and
staging, required-module mode also requires a valid RSA-SHA256
`TIMEOFF_LICENSE` and `TIMEOFF_LICENSE_PUBLIC_KEY`. This makes misconfigured
paid deployments fail closed instead of silently running as community edition.

## Module Shape

The module can export a function:

```js
'use strict';

module.exports = function({registry, context}) {
  registry.registerRoute({
    name: 'premium-dashboard',
    path: '/premium/',
    middleware: [],
    router: require('./routes/premium_dashboard'),
  });
};
```

Or an object with a `register` function:

```js
'use strict';

module.exports = {
  register({registry, context}) {
    registry.registerScheduler({
      name: 'premium-job',
      start({models}) {
        return require('./jobs/premium_job').start({models});
      },
    });
  },
};
```

## Available Context

Route registration receives:

- `app` - Express app instance.
- `passport` - configured Passport instance.
- `coreRoot` - absolute path to the community app root.
- `coreRequire(modulePath)` - requires a module from the community `lib`
  directory, for example `coreRequire('features')`.
- `coreRequirePackage(packageName)` - requires a runtime package from the
  community app, for example `coreRequirePackage('express')`.

Scheduler startup receives:

- `app` - Express app instance.
- `models` - connected DB model object.

Template registration receives the same registry object. Register module-owned
templates before registering routes that render them.

## Registry API

### registerFeature

Premium modules should register their feature names before registering routes,
navigation, providers, or DB models that depend on them:

```js
const features = require('../../lib/features');

features.registerFeature('my_premium_feature');
```

Core keeps only generic feature flag and licensing logic. Feature-specific names
belong to the module that owns the feature.

### registerRoute

```js
registry.registerRoute({
  name: 'my-route',
  path: '/my-route/',
  middleware: [myMiddleware],
  router: expressRouter,
});
```

### registerNavigationItem

```js
registry.registerNavigationItem({
  feature: 'time_balance',
  name: 'time-balance',
  path: '/time-balance/',
  labelKey: 'nav.timeBalance',
  location: 'primary',
  icon: 'fa-clock-o',
  order: 10,
});
```

Navigation items are filtered through `features.isEnabled(feature)` before they
are exposed to templates.

### registerNotificationProvider

```js
registry.registerNotificationProvider({
  feature: 'vacation_planning',
  type: 'pending_vacation_plan',
  translationKey: 'pendingVacationPlan',
  link: '/vacation-plans/',
  fetch({model, actingUser}) {
    return require('./model/vacation_plan').promisePendingPlansFor({
      model,
      actingUser,
    });
  },
});
```

Disabled providers are not returned by the registry, so their implementation can
stay in a private module and will not be loaded for community deployments.

### registerViewPath

```js
const path = require('path');

registry.registerViewPath(path.join(__dirname, 'views'));
```

View paths are added to Express with the core `views` directory first, then
premium directories. This lets private modules keep Handlebars templates beside
their route code while still reusing core layouts and partials.

### registerPartialTemplatePath

```js
const path = require('path');

registry.registerPartialTemplatePath(path.join(__dirname, 'views', 'partials'));
```

Partial paths are added to Handlebars with the core partial directory first,
then premium directories. Use this for feature-specific partials that are only
referenced by premium views.

### registerLocalePath

```js
const path = require('path');

registry.registerLocalePath(path.join(__dirname, 'locales'));
```

Locale paths are merged into i18next after core translations load. Use
`<locale-path>/<language>/translation.json`, for example
`locales/en/translation.json`.

### registerEmailTemplatePath

```js
const path = require('path');

registry.registerEmailTemplatePath(path.join(__dirname, 'views', 'email'));
```

Email template paths let private modules keep feature-specific email templates
outside the core `views/email` directory. The core wrapper template and shared
partials remain available from the community app.

### registerScheduler

```js
registry.registerScheduler({
  name: 'my-scheduler',
  start(context) {
    return {
      stop() {},
    };
  },
});
```

### registerDbModelPath

```js
const path = require('path');

registry.registerDbModelPath(path.join(__dirname, 'db'));
```

DB model paths are loaded by the Sequelize model loader after core model
definitions. Use this for feature-specific table definitions.

### registerMigrationPath

```js
const path = require('path');

registry.registerMigrationPath(path.join(__dirname, 'migrations'));
```

Migration paths are applied by `npm run db-update` after the core `migrations`
directory. Use this for feature-specific schema changes that should exist only
when the premium module is configured.

Keep migration file names stable when moving an existing migration into a
private module. The app stores applied migration file names in `SequelizeMeta`,
so a moved migration with the same file name will not run twice on an existing
customer database.

### registerDbAssociation

```js
registry.registerDbAssociation({
  name: 'my-premium-associations',
  associate(models) {
    if (!models.MyPremiumModel) {
      return;
    }

    models.Company.hasMany(models.MyPremiumModel, {
      as: 'my_premium_models',
      foreignKey: 'companyId',
    });
  },
});
```

DB associations run after core and premium DB models are loaded. Keep callbacks
defensive so the community app can still boot when a private model is absent.

### registerDiagnostic

```js
registry.registerDiagnostic({
  name: 'premium-module',
  collect() {
    return {
      loaded: true,
      moduleName: '@your-company/timeoff-premium',
    };
  },
});
```

Diagnostics must return safe operational metadata only. Do not return raw
licenses, signatures, signing secrets, API tokens, or customer-private data.

## Moving a Feature Into a Private Module

Use this path when extracting a premium feature out of the source-available tree:

1. Move registration into a private module that follows the same contract.
2. Move the route implementation, views, models, jobs, and feature-specific
   helpers into the private module.
3. Keep stable public URLs by registering the moved routes with
   `registry.registerRoute`.
4. Register module-owned Handlebars templates through `registerViewPath`.
5. Register feature partials through `registerPartialTemplatePath`.
6. Register feature email templates through `registerEmailTemplatePath`.
7. Register feature names through `features.registerFeature`.
8. Register feature translations through `registerLocalePath`.
9. Register Sequelize definitions through `registerDbModelPath`.
10. Register schema migrations through `registerMigrationPath`.
11. Register model associations through `registerDbAssociation`.
12. Register any menu entries through `registerNavigationItem`.
13. Register notification counters through `registerNotificationProvider`.
14. Register background jobs through `registerScheduler`.
15. Keep using the same feature name for license checks.
16. In commercial images, set `TIMEOFF_PREMIUM_MODULE_REQUIRED=true` so a missing
   private module fails startup.

The community build should continue to run when the private module is absent.
It should hide premium UI, reject premium direct URLs through feature guards, and
avoid loading private implementation files.
