'use strict';

/*
  UserFeed.feed_token carried the raw bearer credential, so any read of the
  table yielded a live unauthenticated feed URL. The column now stores the
  SHA-256 digest (mirroring the integration API token, migration
  20260707100000): the route hashes the presented token and looks up the
  digest, so existing calendar subscribers keep working unchanged.

  Audit finding #5.
*/
const tokenSecurity = require('../lib/auth/integration_api_token');

module.exports = {
  up: async function(queryInterface) {
    const feeds = await queryInterface.sequelize.query(
      'SELECT id, feed_token FROM '
        + queryInterface.queryGenerator.quoteTable('UserFeeds'),
      {type: require('sequelize').QueryTypes.SELECT}
    );

    for (const feed of feeds) {
      if (feed.feed_token && !/^[0-9a-f]{64}$/.test(feed.feed_token)) {
        await queryInterface.bulkUpdate('UserFeeds', {
          feed_token : tokenSecurity.hashToken(feed.feed_token),
        }, {id: feed.id});
      }
    }
  },

  down: async function() {
    // One-way: raw tokens are not recoverable from digests. Owners regenerate
    // their feeds from /calendar/feeds/.
    return Promise.resolve();
  },
};
