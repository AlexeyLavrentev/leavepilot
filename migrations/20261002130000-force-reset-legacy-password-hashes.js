'use strict';

/*
  Legacy pre-scrypt credentials are peppered-MD5: after any read of the Users
  table they fall to GPU-rate offline cracking, and they cannot be re-hashed
  into scrypt without the plaintext. Emptying the hash fails every login
  closed (the verify path can no longer match) and pushes each owner through
  the forgot-password flow, which issues a fresh scrypt credential bound to
  their email.

  Audit finding #3.
*/
module.exports = {
  up: async function(queryInterface) {
    await queryInterface.bulkUpdate('Users', { password : '' }, {
      password : { [require('sequelize').Op.notLike] : 'scrypt$%' },
    });
  },

  // One-way by design: the legacy hashes are the problem, there is nothing to
  // restore them to.
  down: async function() {
    return Promise.resolve();
  },
};
