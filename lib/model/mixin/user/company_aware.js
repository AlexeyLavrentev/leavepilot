
/*
 * This is a role to be applied to user model that injects getters necessary
 * for fetching related company object with different level of details.
 *
 * Well.. to be precise that role is applied to the object that is used as
 * a spec for instance method for User objects.
 *
 * */

'use strict';
const { Op } = require('sequelize');

const
  dayjs  = require('../../../util/date');

const { sorter } = require("../../../util");

module.exports = function(sequelize){

  /* Fetch company object associated with current user, the company object
   * includes all necessary associations for building user detail page
   * for user determined by user_id.
   * Returns promise that is resolved with company object as parameter
   */
  //
  // TODO: Query below needs to be revisited as it is slow for users
  // with many leaves
  //
  this.get_company_for_user_details = function(args){
    const user_id    = args.user_id,
      _year        = args.year || dayjs.utc(),
      current_user = this;

    return this.getCompany({
      include : [
        {
          model : sequelize.models.User,
          as    : 'users',
          where : { id : user_id },
          include : [

            // Following is needed to be able to calculate how many days were
            // taken from allowance
            {
              model   : sequelize.models.Leave,
              as      : 'my_leaves',
              required : false,
              where : {
                [Op.or] : {
                  date_start : {
                    [Op.between] : [
                      dayjs.utc().startOf('year').format('YYYY-MM-DD'),
                      dayjs.utc().endOf('year').format('YYYY-MM-DD HH:mm'),
                    ]
                  },
                  date_end : {
                    [Op.between] : [
                      dayjs.utc().startOf('year').format('YYYY-MM-DD'),
                      dayjs.utc().endOf('year').format('YYYY-MM-DD HH:mm'),
                    ]
                  }
                }
              },
              include : [{
                    model : sequelize.models.LeaveType,
                    as    : 'leave_type',
                },{
                    model   : sequelize.models.User,
                    as      : 'user',
                    include : [{
                      model   : sequelize.models.Company,
                      as      : 'company',
                      include : [{
                        model : sequelize.models.BankHoliday,
                        as    : 'bank_holidays',
                      }],
                    }],
              }] // End of my_leaves include
            },{
              model : sequelize.models.Department,
              as    : 'department',
            }
          ],
        },{
          model : sequelize.models.Department,
          as : 'departments',
          include : {
            model : sequelize.models.User,
            as : 'boss',
          }
        }
      ],
      order : [
        [
          {model : sequelize.models.Department, as : 'departments'},
          sequelize.models.Department.default_order_field(),
        ]
      ],
    })

    // Make sure that company got only one user associated with for
    // provided user_id
    .then(function(company){

      if (!company || company.users.length !== 1) {
          throw new Error(
              'User '+current_user.id+' tried to edit user '+user_id
                  +' but they do not share a company'
          );
      }

      /*
        The employee comes back nested inside the company, which does not give
        it the other half of the association. The three pages rendered from here
        show whether the employee is still with the company, and that question
        is asked in the company's clock - from a template, which cannot pass the
        answer in. So the company is attached, the way passport and the SSO
        login attach it to the user they authenticate.
      */
      company.users.forEach(user => { user.company = company; });

      return Promise.resolve(company);
    });
  };


  this.get_company_for_add_user = function() {
    const model = sequelize.models;

    return this.getCompany({
      include : [
        {model : model.Department, as : 'departments'}
      ],
      order : [
        [
          {model : model.Department, as : 'departments'},
          model.Department.default_order_field(),
        ]
      ],
    });
  };


  this.get_company_with_all_leave_types = async function() {
    const company = await this.getCompany({
      scope: ['with_leave_types'],
    });

    company.leave_types = company.leave_types
      .sort((a, b) => b.sort_order - a.sort_order || sorter(a.name, b.name));

    return company;
  };

};
