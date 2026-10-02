'use strict';

const expect = require('chai').expect;
const diagnostics = require('../../lib/diagnostics');

describe('Operational diagnostics', function() {
  it('collects safe license, feature, and edition status', async function() {
    const snapshot = await diagnostics.collect({
      env: { NODE_ENV: 'production' },
      features: {
        getLicenseStatus: function() {
          return {
            valid: true,
            reason: 'valid',
            source: 'env',
            customer: 'Example Ltd',
            features: ['time_balance'],
            expires: '2999-12-31T23:59:59.000Z',
          };
        },
        getEnabledMap: function() {
          return {
            time_balance: true,
            vacation_planning: false,
          };
        },
      },
      edition: {
        getInfo: function() {
          return {
            initialized: true,
            premium: {
              loaded: true,
              moduleName: '/opt/timeoff-premium',
              required: true,
            },
            routes: [{name: 'time-balance', path: '/time-balance/'}],
            schedulers: [],
            navigationItems: [{name: 'time-balance', feature: 'time_balance', location: 'primary'}],
            notificationProviders: [{type: 'pending_time_balance_request', feature: 'time_balance'}],
            diagnostics: [{name: 'premium-module'}],
            viewPaths: ['/opt/timeoff-premium/views'],
            emailTemplatePaths: ['/opt/timeoff-premium/email'],
            partialTemplatePaths: ['/opt/timeoff-premium/partials'],
            dbModelPaths: ['/opt/timeoff-premium/db'],
            localePaths: ['/opt/timeoff-premium/locales'],
            migrationPaths: ['/opt/timeoff-premium/migrations'],
            dbAssociations: [{name: 'premium-association'}],
          };
        },
        collectDiagnostics: function() {
          return Promise.resolve([{
            name: 'premium-module',
            loaded: true,
          }]);
        },
      },
    });

    expect(snapshot.environment.nodeEnv).to.equal('production');
    expect(snapshot.application.version).to.be.a('string');
    expect(snapshot.runtime.nodeVersion).to.match(/^v22\./);
    expect(snapshot.runtime.uptimeSeconds).to.be.a('number');
    expect(snapshot.license.valid).to.equal(true);
    expect(snapshot.enabledFeatures.time_balance).to.equal(true);
    expect(snapshot.edition.premium.loaded).to.equal(true);
    expect(snapshot.edition.premium.moduleName).to.equal('/opt/timeoff-premium');
    expect(snapshot.edition.counts.routes).to.equal(1);
    expect(snapshot.edition.counts.migrationPaths).to.equal(1);
    expect(snapshot.moduleDiagnostics).to.deep.equal([{
      name: 'premium-module',
      loaded: true,
    }]);
  });

  it('reports the team-view cache mode and store kind from the injected cache status', async function() {
    const baseDeps = {
      env: { NODE_ENV: 'production' },
      features: {
        getLicenseStatus: function() {
          return { valid: true, reason: 'valid', source: 'env' };
        },
        getEnabledMap: function() {
          return {};
        },
      },
      edition: {
        getInfo: function() {
          return { initialized: true, premium: { loaded: false } };
        },
      },
    };

    const shared = await diagnostics.collect({
      ...baseDeps,
      cache: {
        getStatus: function() {
          return { mode: 'shared', store: 'redis' };
        },
      },
    });
    expect(shared.cache.mode).to.equal('shared');
    expect(shared.cache.store).to.equal('redis');

    const degraded = await diagnostics.collect({
      ...baseDeps,
      cache: {
        getStatus: function() {
          return { mode: 'bypass-store-unavailable', store: 'redis' };
        },
      },
    });
    expect(degraded.cache.mode).to.equal('bypass-store-unavailable');
    expect(degraded.cache.store).to.equal('redis');
  });

  it('does not expose cache connection details even when the status object carries them', async function() {
    const snapshot = await diagnostics.collect({
      env: { NODE_ENV: 'production' },
      cache: {
        getStatus: function() {
          return {
            mode: 'shared',
            store: 'redis',
            host: 'redis.internal.example.test',
            port: 6379,
            password: 'cache-password-value',
            token: 'cache-token-value',
            connectionString: 'redis://:cache-password-value@redis.internal.example.test:6379',
          };
        },
      },
      features: {
        getLicenseStatus: function() {
          return { valid: true, reason: 'valid', source: 'env' };
        },
        getEnabledMap: function() {
          return {};
        },
      },
      edition: {
        getInfo: function() {
          return { initialized: true, premium: { loaded: false } };
        },
      },
    });

    const serialized = JSON.stringify(snapshot.cache);
    expect(serialized).to.contain('shared');
    expect(serialized).to.contain('redis');
    expect(serialized).to.not.contain('redis.internal.example.test');
    expect(serialized).to.not.contain('6379');
    expect(serialized).to.not.contain('cache-password-value');
    expect(serialized).to.not.contain('cache-token-value');
    expect(snapshot.cache).to.have.all.keys('mode', 'store');
  });

  it('reports delivery backlog counts from the injected counting function', async function() {
    const snapshot = await diagnostics.collect({
      env: { NODE_ENV: 'production' },
      deliveryCounts: function() {
        return Promise.resolve({ pending: 3, failed: 1 });
      },
      features: {
        getLicenseStatus: function() {
          return { valid: true, reason: 'valid', source: 'env' };
        },
        getEnabledMap: function() {
          return {};
        },
      },
      edition: {
        getInfo: function() {
          return { initialized: true, premium: { loaded: false } };
        },
      },
    });

    expect(snapshot.delivery).to.deep.equal({ pending: 3, failed: 1 });
  });

  it('reports null delivery counts without throwing when counting rejects', async function() {
    const snapshot = await diagnostics.collect({
      env: { NODE_ENV: 'production' },
      deliveryCounts: function() {
        return Promise.reject(new Error('database unavailable'));
      },
      features: {
        getLicenseStatus: function() {
          return { valid: true, reason: 'valid', source: 'env' };
        },
        getEnabledMap: function() {
          return {};
        },
      },
      edition: {
        getInfo: function() {
          return { initialized: true, premium: { loaded: false } };
        },
      },
    });

    expect(snapshot.delivery).to.deep.equal({ pending: null, failed: null });
  });

  it('keeps the delivery section to exactly the two counts even when the counter returns more', async function() {
    const snapshot = await diagnostics.collect({
      env: { NODE_ENV: 'production' },
      deliveryCounts: function() {
        return Promise.resolve({
          pending: 2,
          failed: 1,
          last_error: 'SMTP 535 authentication failed',
          payload: '{"leaveId":15}',
          recipient: 'approver@example.test',
          token: 'delivery-token-value',
          records: [{id: 7, status: 'failed'}],
        });
      },
      features: {
        getLicenseStatus: function() {
          return { valid: true, reason: 'valid', source: 'env' };
        },
        getEnabledMap: function() {
          return {};
        },
      },
      edition: {
        getInfo: function() {
          return { initialized: true, premium: { loaded: false } };
        },
      },
    });

    expect(snapshot.delivery).to.have.all.keys('pending', 'failed');
    expect(snapshot.delivery.pending).to.equal(2);
    expect(snapshot.delivery.failed).to.equal(1);

    const serialized = JSON.stringify(snapshot.delivery);
    expect(serialized).to.not.contain('SMTP');
    expect(serialized).to.not.contain('leaveId');
    expect(serialized).to.not.contain('approver@example.test');
    expect(serialized).to.not.contain('delivery-token-value');
  });

  it('does not expose raw licenses, signatures, secrets, tokens, or keys', async function() {
    const snapshot = await diagnostics.collect({
      env: {
        NODE_ENV: 'production',
        TIMEOFF_LICENSE: 'raw-license-value',
        TIMEOFF_LICENSE_SECRET: 'license-secret-value',
        TIMEOFF_LICENSE_PUBLIC_KEY: 'public-key-value',
      },
      features: {
        getLicenseStatus: function() {
          return {
            valid: true,
            reason: 'valid',
            raw: 'raw-license-value',
            signature: 'signature-value',
            secret: 'license-secret-value',
            token: 'token-value',
            publicKey: 'public-key-value',
            privateKey: 'private-key-value',
            customer: 'Example Ltd',
            features: ['time_balance'],
          };
        },
        getEnabledMap: function() {
          return { time_balance: true };
        },
      },
      edition: {
        getInfo: function() {
          return {
            initialized: true,
            premium: {
              loaded: true,
              moduleName: '/opt/timeoff-premium',
              required: true,
            },
          };
        },
        collectDiagnostics: function() {
          return Promise.resolve([{
            name: 'unsafe-module',
            signature: 'signature-value',
            accessToken: 'access-token-value',
            nested: {
              secret: 'license-secret-value',
              token: 'token-value',
              publicKey: 'public-key-value',
              privateKey: 'private-key-value',
            },
          }]);
        },
      },
    });
    const serialized = JSON.stringify(snapshot);

    expect(serialized).to.not.contain('raw-license-value');
    expect(serialized).to.not.contain('signature-value');
    expect(serialized).to.not.contain('license-secret-value');
    expect(serialized).to.not.contain('token-value');
    expect(serialized).to.not.contain('public-key-value');
    expect(serialized).to.not.contain('private-key-value');
    expect(serialized).to.not.contain('access-token-value');
    expect(snapshot.license.raw).to.equal(undefined);
    expect(snapshot.license.signature).to.equal(undefined);
    expect(snapshot.moduleDiagnostics[0].nested).to.deep.equal({});
  });
});
