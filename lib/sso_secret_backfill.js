'use strict';

const defaultSecretStore = require('./secret_store');

const CATEGORIES = [
  'encrypted',
  'plaintext',
  'empty',
  'malformed',
  'decryptionFailed',
];

function emptyCounts() {
  return CATEGORIES.reduce(function(counts, category) {
    counts[category] = 0;
    return counts;
  }, {});
}

function classifyRow(row, secretStore) {
  const store = secretStore || defaultSecretStore;
  let config;

  if (row.sso_auth_config === null || row.sso_auth_config === undefined || row.sso_auth_config === '') {
    return { category: 'empty' };
  }

  try {
    config = typeof row.sso_auth_config === 'string'
      ? JSON.parse(row.sso_auth_config)
      : row.sso_auth_config;
  } catch {
    return { category: 'malformed' };
  }

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { category: 'malformed' };
  }

  if (!Object.prototype.hasOwnProperty.call(config, 'client_secret') || config.client_secret === '') {
    return { category: 'empty' };
  }

  if (typeof config.client_secret !== 'string') {
    return { category: 'malformed' };
  }

  if (!store.isEncrypted(config.client_secret)) {
    return { category: 'plaintext', config: config };
  }

  try {
    store.decryptSecret(config.client_secret);
    return { category: 'encrypted' };
  } catch {
    return { category: 'decryptionFailed' };
  }
}

function summarizeRows(rows, secretStore) {
  const counts = emptyCounts();
  const classified = (rows || []).map(function(row) {
    const result = classifyRow(row, secretStore);
    counts[result.category] += 1;
    return {
      id: row.id,
      category: result.category,
      config: result.config,
    };
  });

  return {
    counts: counts,
    total: classified.length,
    classified: classified,
  };
}

function publicSummary(summary, changed) {
  return {
    total: summary.total,
    encrypted: summary.counts.encrypted,
    plaintext: summary.counts.plaintext,
    empty: summary.counts.empty,
    malformed: summary.counts.malformed,
    decryptionFailed: summary.counts.decryptionFailed,
    changed: changed || 0,
  };
}

function readRows(sequelize) {
  return sequelize.query(
    'SELECT id, sso_auth_config FROM `Companies`',
    { type: sequelize.QueryTypes.SELECT }
  );
}

function audit(options) {
  const opts = options || {};
  const store = opts.secretStore || defaultSecretStore;

  return readRows(opts.sequelize).then(function(rows) {
    return publicSummary(summarizeRows(rows, store), 0);
  });
}

function safeError(code, message, summary) {
  const error = new Error(message);
  error.code = code;
  error.summary = summary;
  return error;
}

function apply(options) {
  const opts = options || {};
  const sequelize = opts.sequelize;
  const queryInterface = opts.queryInterface || sequelize.getQueryInterface();
  const store = opts.secretStore || defaultSecretStore;

  return readRows(sequelize).then(function(rows) {
    const summary = summarizeRows(rows, store);
    const safeSummary = publicSummary(summary, 0);

    if (summary.counts.decryptionFailed > 0) {
      throw safeError(
        'SSO_SECRET_DECRYPTION_FAILED',
        'SSO secret backfill refused: encrypted values cannot be decrypted with the configured key',
        safeSummary
      );
    }

    if (summary.counts.plaintext === 0) {
      return safeSummary;
    }

    try {
      store.encryptSecret('key-availability-check');
    } catch {
      throw safeError(
        'SSO_SECRET_KEY_MISSING',
        'SSO secret backfill refused: encryption key is not configured',
        safeSummary
      );
    }

    return sequelize.transaction(function(transaction) {
      return summary.classified.reduce(function(sequence, row) {
        if (row.category !== 'plaintext') {
          return sequence;
        }

        return sequence.then(function() {
          const config = Object.assign({}, row.config, {
            client_secret: store.encryptSecret(row.config.client_secret),
          });

          return queryInterface.bulkUpdate(
            'Companies',
            { sso_auth_config: JSON.stringify(config) },
            { id: row.id },
            { transaction: transaction }
          );
        });
      }, Promise.resolve());
    }).then(function() {
      return publicSummary(summary, summary.counts.plaintext);
    });
  });
}

function formatSummary(mode, summary) {
  return [
    'SSO secret backfill ' + mode,
    'total=' + summary.total,
    'encrypted=' + summary.encrypted,
    'plaintext=' + summary.plaintext,
    'empty=' + summary.empty,
    'malformed=' + summary.malformed,
    'decryption_failed=' + summary.decryptionFailed,
    'changed=' + summary.changed,
  ].join(' ');
}

module.exports = {
  CATEGORIES,
  apply,
  audit,
  classifyRow,
  formatSummary,
  summarizeRows,
};
