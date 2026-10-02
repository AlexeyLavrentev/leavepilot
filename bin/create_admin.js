'use strict';

/*
 * First-run helper: creates a company and its administrator account from
 * the command line, so operators do not have to temporarily enable public
 * registration to bootstrap an installation.
 *
 * Usage:
 *   npm run create-admin -- --email admin@example.com --company "My Company"
 *
 * Options:
 *   --email     (required) admin login email
 *   --company   (required) company name
 *   --password  admin password; a random one is generated and printed if omitted
 *   --country   ISO country code for the company (default: RU)
 *   --timezone  company timezone (default derived from country)
 *   --name      admin first name (default: Admin)
 *   --lastname  admin last name (default: Admin)
 */

const log = require('../lib/middleware/request_logger');

const argv = require('minimist')(process.argv.slice(2));
const crypto = require('crypto');
const validator = require('validator');

const models = require('../lib/model/db');
const teamViewCache = require('../lib/cache/team_view_cache');

// The post-commit invalidation bumps are fire-and-forget: CLIs give them a
// bounded moment to drain before closing the shared resources, so a healthy
// run does not end with artifact red invalidation events (the full bump
// retry window is ~150 ms; 400 ms covers it with margin).
const INVALIDATION_DRAIN_MS = 400;

function fail(message) {
  log.error('create_admin_error', { message });
  log.error('create_admin_usage', {
    usage: 'npm run create-admin -- --email admin@example.com --company "My Company" [--password ...] [--country RU] [--timezone Europe/Moscow] [--name Admin] [--lastname Admin]',
  });
  process.exit(1);
}

const email = String(argv.email || '').trim().toLowerCase();
const companyName = String(argv.company || '').trim();
let password = argv.password ? String(argv.password) : null;
const countryCode = String(argv.country || 'RU').trim().toUpperCase();
const timezone = argv.timezone ? String(argv.timezone).trim() : undefined;
const firstName = String(argv.name || 'Admin').trim();
const lastName = String(argv.lastname || 'Admin').trim();

if (!email || !validator.isEmail(email)) {
  fail('--email is required and must be a valid email address');
}

if (!companyName) {
  fail('--company is required');
}

let generatedPassword = false;

if (!password) {
  // URL-safe, no ambiguous characters; 16 chars of base64url ≈ 96 bits
  password = crypto.randomBytes(12).toString('base64url');
  generatedPassword = true;
}

if (password.length < 8) {
  fail('--password must be at least 8 characters long');
}

async function main() {
  let failed = false;
  try {
    await models.connect();
    const user = await models.User.register_new_admin_user({
      email        : email,
      password     : password,
      name         : firstName,
      lastname     : lastName,
      company_name : companyName,
      country_code : countryCode,
      timezone     : timezone,
      activated    : true,
    });
    log.info('administrator_created', {
      company: companyName,
      email: user.email,
    });
    if (generatedPassword) {
      log.info('generated_password', { password });
      log.info('password_notice', { msg: 'This generated password is shown only once. Store it securely and change it after the first login.' });
    }
    log.info('signin_url', { url: '/login/' });
  } catch (error) {
    failed = true;
    log.error('create_admin_failed', {
      error: error && error.show_to_user ? error.message : (error && error.stack || String(error)),
    });
  } finally {
    // The post-commit invalidation hooks open the shared-store cache client
    // lazily on the first mutation; close it alongside the database so this
    // CLI never hangs on a dangling Redis socket.
    await new Promise(resolve => setTimeout(resolve, INVALIDATION_DRAIN_MS));
    await teamViewCache.close().catch(function() {});
    await models.sequelize.close().catch(function() {});
  }
  if (failed) {
    process.exit(1);
  }
}

main();
