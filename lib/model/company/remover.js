
"use strict";

const
  Joi       = require('joi'),
  Promise   = require('bluebird'),
  Exception = require('../../error'),
  Models    = require('../db');

const
  schemaPromiseToRemove = Joi.object().required().keys({
    company     : Joi.object().required(), //.type(Models.Company.constructor),
    byUser      : Joi.object().required(), //.type(Models.User.constructor),
    confirmName : Joi.string().required().trim(),
  });


class CompanyRemover {

  static promiseToRemove(args){

    args = Joi.attempt(
      args,
      schemaPromiseToRemove,
      "Param validation failed for promiseToRemove"
    );

    const
      company      = args.company,
      byUser       = args.byUser,
      confirmName  = args.confirmName;

    // Ensure that confirm name is correct
    let normalizedNames = [company.name, confirmName]
      .map(s => s.trim())
      .map(s => s.replace(/\s+/g, ''))
      .map(s => s.toUpperCase());

    if (normalizedNames[0] !== normalizedNames[1]) {
      Exception.throw_user_error({
        system_error : `Confirmed name does not match one on company record: ${ normalizedNames.join(', ') }`,
        user_error   : `Provided name confirmation does not match company one`,
      });
    }

    return Models.sequelize.transaction(transaction =>
      Models.User

        // Ensure user belongs to current combany and is admin
        .count({
          where : {
            id        : byUser.id,
            companyId : company.id,
            admin     : true,
          },
          transaction,
        })
        .then(count => {
          if ( count === 0) {
            Exception.throw_user_error({
              system_error : `An attempt to remove company [${company.id}] by unrelated user [${byUser.id }]`,
              user_error : `User does not have permissions to remove company`,
            });
          }
          return Promise.resolve(1);
        })

        // Remove company record and all related sensitive data atomically.
        .then(() => Models.EmailAudit.destroy({
          where : { company_id : company.id },
          transaction,
        }))
        .then(() => Promise
          .resolve(company.getUsers({transaction}))
          .then(users => Promise.all(users.map(user => Models.Leave.destroy({
            where : { userId : user.id },
            transaction,
          }))))
        )
        .then(() => Models.User.destroy({
          where : {companyId : company.id},
          transaction,
        }))
        .then(() => company.destroy({transaction}))
    );
  }
}

module.exports = CompanyRemover;
