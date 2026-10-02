'use strict';

var expect = require('chai').expect;
var community = require('../../lib/edition/community');

describe('Community edition module', function() {
  function createRegistry() {
    return {
      routes: [],
      navigationItems: [],
      notificationProviders: [],
      registerRoute: function(route) {
        this.routes.push(route);
      },
      registerNavigationItem: function(item) {
        this.navigationItems.push(item);
      },
      registerNotificationProvider: function(provider) {
        this.notificationProviders.push(provider);
      },
      registerSsoProvider: function() {},
      registerMultipartRoute: function(route) {
        this.multipartRoutes.push(route);
      },
      registerScheduler: function(scheduler) {
        this.schedulers.push(scheduler);
      },
      registerDeliveryExecutor: function(executor) {
        this.deliveryExecutors.push(executor);
      },
      schedulers: [],
      multipartRoutes: [],
      deliveryExecutors: [],
    };
  }

  it('registers only community implementations', function() {
    var registry = createRegistry();
    var result = community.register({registry: registry});

    expect(result.name).to.equal('community');
    expect(registry.routes.map(function(route) { return route.name; }))
      .to.deep.equal(['reminder-schedules-settings', 'reminder-schedules-api']);
    expect(registry.schedulers.map(function(scheduler) { return scheduler.name; }))
      .to.deep.equal(['leave-start-reminders', 'delivery-outbox']);
    expect(registry.notificationProviders).to.deep.equal([]);
    expect(registry.navigationItems.map(function(item) { return item.name; }))
      .to.deep.equal(['auth-config', 'reminder-schedules']);
    expect(registry.multipartRoutes).to.deep.equal([
      {method: 'POST', path: '/users/import/'},
    ]);
  });

  it('registers the community delivery executors for email and edition events', function() {
    var registry = createRegistry();
    community.register({registry: registry});

    expect(registry.deliveryExecutors.map(function(executor) {
      return executor.deliveryType;
    })).to.deep.equal(['email', 'edition_event']);
    registry.deliveryExecutors.forEach(function(executor) {
      expect(executor.deliver).to.be.a('function');
    });
  });
});
