
'use strict';

const
  {Op} = require('sequelize'),
  Bluebird = require('bluebird'),
  Models = require('./db');

/*
  Attributes whose value is a credential rather than a fact about an employee.

  The audit trail stores oldValue and newValue verbatim, and both writers hand
  it a whole user row: the edit path hashes an admin-submitted password into the
  very object it then audits, and the delete path enumerates every column of the
  record. Recording those wrote the scrypt hash together with its salt into a
  table that the premium integration API serves to whoever holds a company's
  static token.

  A credential column added to User in future must be listed here.
  t/unit/audit_credentials.js fails when one appears that is not.
*/
const NEVER_AUDITED_ATTRIBUTES = ['password'];

const isAuditable = attribute => !NEVER_AUDITED_ATTRIBUTES.includes(attribute);

const getAuditCaptureForUser = ({byUser, forUser, newAttributes}) => () => {
  const attributeUpdates = Object.keys(newAttributes)
    .filter(isAuditable)
    .filter(k => String(newAttributes[k]) !== String(forUser[k]))
    .map(
      attribute => Models.Audit.create({
        companyId:  byUser.companyId,
        byUserId:   byUser.id,
        entityType: 'USER',
        entityId:   forUser.id,
        attribute,
        oldValue:   String(forUser[attribute]),
        newValue:   String(newAttributes[attribute]),
      })
    );

  return Bluebird.map(attributeUpdates, f => f, {concurrency : 5});
};

const getAudit = ({companyId}) => {
  return Models.Audit.findAll({
    where : {
      companyId,

      // A deployment that recorded these before the filter existed still holds
      // the rows until the purge migration runs, and a reader must not serve
      // them in the meantime.
      attribute : {[Op.notIn] : NEVER_AUDITED_ATTRIBUTES},
    },
    raw: true,
  })
};

module.exports = {
  getAuditCaptureForUser,
  getAudit,
  NEVER_AUDITED_ATTRIBUTES,
};
