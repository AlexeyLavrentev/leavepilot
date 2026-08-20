"use strict";
const { Op } = require('sequelize');

const
    crypto        = require('crypto'),
    _             = require('underscore'),
    moment        = require('moment'),
    Promise       = require("bluebird"),
    config        = require('../../config'),
    passwordHasher = require('../../auth/password'),

    UserAllowance = require('../user_allowance'),
    { convert: htmlToText } = require('html-to-text'),

    // User mixins
    withCompanyAwareness = require('../mixin/user/company_aware'),
    withAbsenceAwareness = require('../mixin/user/absence_aware');

const { sorter } = require("../../util");
const seatLimit = require('../../licensing/seat_limit');

const LeaveCollectionUtil = require('../leave_collection')();
const {
  createPasswordResetToken,
  decodePasswordResetToken,
  verifyPasswordResetToken,
} = require('../../auth/password_reset_token');

module.exports = function(sequelize, DataTypes) {

  var instance_methods = get_instance_methods(sequelize);

  withCompanyAwareness.call ( instance_methods, sequelize ) ;
  withAbsenceAwareness.call ( instance_methods, sequelize ) ;

  var class_methods = get_class_methods(sequelize);

  withAssociations.call ( class_methods, sequelize ) ;
  withScopes.call       ( class_methods, sequelize ) ;

  var User = sequelize.define("User", {
      // TODO add validators!
      email : {
          type      : DataTypes.STRING,
          allowNull : false
      },
      password : {
          type      : DataTypes.STRING,
          allowNull : false
      },
      name : {
          type      : DataTypes.STRING,
          allowNull : false
      },
      lastname : {
          type      : DataTypes.STRING,
          allowNull : false
      },
      activated : {
          type         : DataTypes.BOOLEAN,
          allowNull    : false,
          defaultValue : false,
          comment      : 'This flag means that user account was activated, e.g. login',
      },
      admin : {
          type         : DataTypes.BOOLEAN,
          allowNull    : false,
          defaultValue : false,
          comment      : 'Indicate if account can edit company wide settings',
      },
      auto_approve : {
        type         : DataTypes.BOOLEAN,
        allowNull    : false,
        defaultValue : false,
        comment      : 'Indicate if leave request from current employee are auto approved',
      },
      is_critical : {
        type         : DataTypes.BOOLEAN,
        allowNull    : false,
        defaultValue : false,
        comment      : 'Indicate if employee is critical for department operations',
      },
      start_date : {
          type         : DataTypes.DATE,
          allowNull    : false,
          defaultValue : DataTypes.NOW,
          comment      : 'Date employee start to work for company',
          get: function(){
            return moment.utc(this.getDataValue('start_date')).format('YYYY-MM-DD');
          },
      },
      end_date : {
          type         : DataTypes.DATE,
          allowNull    : true,
          defaultValue : null,
          comment      : 'Date emplyee stop working for company',
          get: function(){
            const endDate = this.getDataValue('end_date');
            if ( ! endDate ) {
              return endDate;
            }

            return moment.utc(endDate).format('YYYY-MM-DD');
          },
      },
  }, {
      indexes : [
        {
          fields : ['companyId'],
        },
        {
          fields : ['lastname'],
        },
      ],
    });

    // sequelize 5+ убрал опции classMethods/instanceMethods — навешиваем вручную
    Object.keys(class_methods).forEach(function(name){
      User[name] = class_methods[name];
    });
    Object.keys(instance_methods).forEach(function(name){
      User.prototype[name] = instance_methods[name];
    });

    User.addHook('beforeSave', function(user, options) {
      return seatLimit.assertUserSaveWithinLimit({User, user, options});
    });
    User.addHook('beforeBulkCreate', function(users, options) {
      return seatLimit.assertBulkSaveWithinLimit({User, users, options});
    });

    const resolveCompanyModel = function() {
      if (sequelize.models.Company) return sequelize.models.Company;

      const association = Object.keys(User.associations)
        .map(name => User.associations[name])
        .find(item => item.foreignKey === 'companyId');
      return association && association.target;
    };

    const saveWithoutSeatLock = User.prototype.save;
    User.prototype.save = function(options) {
      const user = this;
      const saveOptions = options || {};
      if (saveOptions.seatLimitLockHeld || !seatLimit.userConsumesNewSeat(user)) {
        return saveWithoutSeatLock.call(user, saveOptions);
      }

      return seatLimit.withCompanySeatLocks({
        sequelize,
        Company: resolveCompanyModel(),
        companyIds: [user.companyId],
        transaction: saveOptions.transaction,
        operation: transaction => saveWithoutSeatLock.call(user, Object.assign({}, saveOptions, {
          transaction,
          seatLimitLockHeld: true,
        })),
      });
    };

    const bulkCreateWithoutSeatLock = User.bulkCreate.bind(User);
    User.bulkCreate = function(records, options) {
      const bulkOptions = options || {};
      const users = records.map(record => User.build(record));
      const companyIds = users
        .filter(seatLimit.userConsumesNewSeat)
        .map(user => user.companyId);

      if (bulkOptions.seatLimitLockHeld || !companyIds.length) {
        return bulkCreateWithoutSeatLock(records, bulkOptions);
      }

      return seatLimit.withCompanySeatLocks({
        sequelize,
        Company: resolveCompanyModel(),
        companyIds,
        transaction: bulkOptions.transaction,
        operation: transaction => bulkCreateWithoutSeatLock(records, Object.assign({}, bulkOptions, {
          transaction,
          seatLimitLockHeld: true,
        })),
      });
    };

    return User;
};


/*
 * Convenience method that returns an object with definition of User's instance methods.
 *
 * */
function get_instance_methods(sequelize) {

  return {

    is_my_password : function( password ) {
        const stored = this.password;

        // New scrypt hashes carry an algorithm prefix; anything else is a
        // legacy unsalted MD5 hash stored by older releases.
        if (passwordHasher.isScryptHash(stored)) {
            return passwordHasher.verifyPassword( password, stored );
        }

        return sequelize.models.User.hashify_password_legacy( password ) === stored;
    },

    // True when the stored password hash should be upgraded to the current
    // algorithm on the next successful login.
    password_needs_rehash : function() {
        return passwordHasher.needsRehash( this.password );
    },

    /*
     * Activate user only when it is inactive.
     * Return promise that gets user's object.
     * */
    maybe_activate : function(){
      if ( ! this.activated ) {
          this.activated = true;
      }
      return this.save();
    },

    is_admin : function() {
      return this.admin === true;
    },

    promise_can_view_all_absences : async function() {
      if (this.is_admin()) {
        return true;
      }

      const company = this.company || await this.getCompany();
      if (company && company.share_all_absences) {
        return true;
      }

      const groups = this.groups || await this.getGroups({ through: { attributes: [] } });
      return groups.some(group => group.is_hr_group);
    },

    /*
     * Indicates is leave requests from current user are automatically approved
     * */
    is_auto_approve : function(){
      return this.auto_approve === true;
    },

    full_name : function() {
      return this.name + ' ' + this.lastname;
    },

    /*
      Indicates if the user is active.

      end_date is the employee's last working day, and whether it has passed has
      to be asked in the company's own clock. This asked it in UTC, while the
      rest of the application asks Company.get_today() - the same comparison is
      made correctly against the company in the users route, a few hundred lines
      from here. So for the offset between UTC and the company's timezone, every
      single day:

        - a company ahead of UTC carried a departed employee as active after
          their last day had ended: an hour for Europe/London in summer, three
          for Europe/Moscow, five or six for Asia/Almaty;
        - a company behind UTC struck an employee's name through while their
          last day was still going, and the edition that gates login on this
          refused them a login on it.

      The boundary can be passed in by a caller that has the company but not the
      association. Otherwise it comes from the company when that is loaded, and
      from UTC when it is not: this is called from a template, which cannot pass
      an argument, and it is synchronous, so it cannot go and fetch one. Every
      path that gates access on it attaches the company first - see passport,
      the login route, and the SSO login in the premium edition - and the two
      that render it either pass the boundary or attach the company.

      Company.get_today() is already a UTC moment at the start of the company's
      calendar day, so it compares directly against end_date.
    */
    is_active : function(today){
      const boundary = today
        || (this.company ? this.company.get_today() : moment.utc().startOf('day'));

      return this.end_date === null || moment.utc(this.end_date).isSameOrAfter(boundary);
    },

    // TODO VPP: rename this method as its name misleading: it returns all users
    // managed by current users + user itself, so it should be something like
    // "promise_all_supervised_users_plus_me"
    // In fact this method probably have to be ditched in favour of more granular ones
    //
    /*
      options.attributes narrows the columns fetched for the admin branch.

      The session path is the only caller that passes it, and it needs three
      columns out of fifteen. Left unrestricted, every authenticated request by
      an admin hydrated the entire employee table - all columns, password hash
      included - to populate a dropdown that uses nothing but the id and the
      name. Measured at 250 employees that is 250 full rows per request.

      Every other caller - three in core, six in the premium edition - works with
      whole user objects, so the default is unchanged and this stays opt-in
      rather than a narrowing everyone has to notice.

      Two limits worth knowing before reaching for this elsewhere:

      - only the admin branch honours it. The supervisor branch goes through
        promise_supervised_departments, which has callers of its own, so
        threading the option down there is a separate change. Its cost is
        bounded by the departments a person supervises rather than by the whole
        company, which is why it was not the measured problem.

      - the rows come back as partially loaded model instances, and sequelize
        does not complain about a column it never fetched. Instance methods that
        read one answer confidently and wrongly rather than throwing:
        is_active() reads end_date, and moment.utc(undefined) is now, so a
        terminated employee reads as active. Only ask for a narrowed list when
        the caller reads the columns it asked for and nothing else.
    */
    promise_users_I_can_manage : async function(options){
      const self = this;
      const attributes = (options || {}).attributes;

      let users = [];

      if ( self.is_admin() ) {
        // Check if current user is admin, then fetch all users form company
        //
        // Narrowing overrides the include rather than querying User directly.
        // That matters more than it looks: views/partials/book_leave_modal.hbs
        // renders `value="{{@index}}"`, a position in this array, and
        // lib/route/calendar.js resolves that index against another call to
        // this method. The two only agree because they run the same statement -
        // the sort here is on lastname alone, so colleagues sharing a surname
        // are ordered by whatever the query plan returns. Same shape, fewer
        // columns, same order.
        const company = await self.getCompany(
          attributes
            ? { include : [{ model : sequelize.models.User, as : 'users', attributes }] }
            : { scope : ['with_all_users'] }
        );

        users = company.users;

      } else {
        // If current user has any departments under supervision then get
        // all users from those departments plus user himself,
        // if no supervised users an array with only current user is returned
        const departments = await self.promise_supervised_departments();

        users = departments.map(({users}) => users).flat();
      }

      // Make sure current user is considered as well
      users.push(self);

      users = _.uniq(users, ({id}) => id);
      users = users.sort((a, b) => sorter(a.lastname, b.lastname));

      return users;
    },

    /*
     * Return user's boss, the head of department user belongs to
     *
     * */
    promise_boss : function(){
      return this.getDepartment({
        scope : ['with_boss'],
      })
      .then(department => Promise.resolve( department.boss ));
    },

    /*
     *  Return users who could supervise current user, that is those who could
     *  approve its leave requests and who can create leave requests on behalf of
     *  those user.
     *
     * */
    promise_supervisors : function(){
      return this.getDepartment({
        scope : ['with_boss', 'with_supervisors'],
      })
      .then( department => {
        if (!department) { return Promise.resolve([]); }
        return Promise.resolve( _.flatten([ department.boss, department.supervisors ]) );
      } );
    },

    promise_supervised_departments : function() {
      let self = this;
      // Lazy require to avoid circular dependency (edition → model → edition)
      const edition = require('../../edition');

      return sequelize.models.DepartmentSupervisor.findAll({ where : { user_id : self.id } })
        // Obtain departments current user supervises as secondary supervisor
        .then(department_supervisors => department_supervisors.map( obj => obj.department_id ))
        .then( department_ids => {

          if ( ! department_ids ) {
            department_ids = [];
          }

          // Merge delegated department IDs from premium (no-op in community: returns [])
          return edition.getSupervisedDepartmentIds({user: self}).then(delegatedIds => {
            const allIds = department_ids.concat(delegatedIds || []);

            return sequelize.models.Department.scope('with_simple_users').findAll({
              where : {
                [Op.or] : [
                  { id : allIds },
                  { bossId : self.id },
                ]
              }
            });
          });
        });
    },

    promise_supervised_users : function () {
      let self = this;

      return self
        .promise_supervised_departments()
        .then(departments => {
          return self.constructor.findAll({ where : { DepartmentId : departments.map(d => d.id ) } });
        })
    },


    // Generate object that represent Employee allowance
    promise_allowance : function(args) {
      args = args || {};
      // Override user to be current one
      args.user = this;
      return UserAllowance.promise_allowance(args);
    },

    reload_with_leave_details : function(args){
      const self = this;
      const dbModel = self.sequelize.models;

      return Promise.join(
        self.promise_my_active_leaves(args)
          .then(leaves => LeaveCollectionUtil.enrichLeavesWithComments({leaves, dbModel})),
        self.getDepartment(),
        self.promise_schedule_I_obey(),
        function(leaves, department, schedule){
          self.my_leaves = leaves;
          self.department = department;

          // Note: we do not do anything with scheduler as "promise_schedule_I_obey"
          // sets the "cached_schedule" attribute under the hood, which is used in
          // synchronous code afterwards. Yes... itaza`z is silly, but it is where we are
          // at thi moment after mixing non blocking and blocking code together...
          //
          return Promise.resolve(self);
        }
      );

    },

    // This method reload user object to have all necessary information to render
    // each page
    reload_with_session_details : function(){
      var self = this;
      return Promise.join(
        /*
          Only the columns the two readers of supervised_users touch:
          lib/model/team_view.js keys a map by id, and
          views/partials/book_leave_modal.hbs renders the id and full_name,
          which is name + lastname. lastname also drives the sort below.

          Everything else on the row - not least the password hash - was being
          loaded once per employee on every authenticated request an admin
          made, and read by nobody.
        */
        self.promise_users_I_can_manage({attributes : ['id', 'name', 'lastname']}),
        self.get_company_with_all_leave_types(),
        self.promise_schedule_I_obey(),
        function(users, company, schedule){
          self.supervised_users = users || [];
          self.company = company;
          self.isDepartmentBoss = self.is_admin()
            || (users || []).some(u => Number(u.id) !== Number(self.id));

          // Note: we do not do anything with scheduler as "promise_schedule_I_obey"
          // sets the "cached_schedule" attribute under the hood, which is used in
          // synchronous code afterwards. Yes... it is silly, but it is where we are
          // at thi moment after mixing non blocking and blocking code together...

          return Promise.resolve(self);
        });
    },


    remove : function() {
      var self = this;

      // make sure I am not admin, otherwise throw an error
      if (self.is_admin()) {
        throw new Error('Cannot remove administrator user');
      }

      // make sure I am not supervisor, otherwise throw an error
      return self.promise_supervised_departments()
        .then(departments => {
          if (departments.length > 0){
            throw new Error("Cannot remove supervisor");
          }

          return self.getMy_leaves();
        })
        .then(function(leaves){
          // remove all leaves
          return Promise.all(
            _.map( leaves, function(leave){ return leave.destroy(); })
          );
        })

        // remove user record
        .then(function(){
          return self.destroy();
        })

    },

    get_reset_password_token : function(){
      const configuredTtlMinutes = Number(
        process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES
        || config.get('password_reset_token_ttl_minutes')
        || 60
      );
      const ttlMinutes = Number.isFinite(configuredTtlMinutes) && configuredTtlMinutes > 0
        ? configuredTtlMinutes
        : 60;

      return createPasswordResetToken({
        email: this.email,
        passwordHash: this.password,
        secret: config.get('crypto_secret'),
        ttlMs: ttlMinutes * 60 * 1000,
      });
    },

    // Accept an object that represent email to be sent to current user and
    // record it into the corresponding audit table
    //
    record_email_addressed_to_me : function(email_obj) {

      // validate email object to contain all necessary fields
      if ( ! email_obj ||
        ! email_obj.hasOwnProperty('subject') ||
        ! email_obj.subject ||
        ! email_obj.hasOwnProperty('body') ||
        ! email_obj.body
      ) {
        throw new Error(
          'Got incorrect parameters. There should be an object '+
          'to represent and email and contain subject and body'
        );
      }

      const promise_action = this.sequelize.models.EmailAudit.create({
        email      : this.email,
        subject    : htmlToText(email_obj.subject, { wordwrap: false }),
        body       : htmlToText(email_obj.body, { wordwrap: false }),
        user_id    : this.id,
        company_id : this.companyId,
      });

      return promise_action;
    },

    promise_schedule_I_obey : function(){
      var self = this;

      if ( self.cached_schedule ) {
        return Promise.resolve( self.cached_schedule );
      }

      return self.sequelize.models.Schedule
        .findAll({
          where : {
            [Op.or] : [
              { user_id : self.id },
              { company_id : self.companyId },
            ]
          }
        })
        .then(function(schedules){

          // no schedules for current user in DB, return default one
          if (schedules.length === 0) {
            return self.sequelize.models.Schedule
              .promise_to_build_default_for({ company_id : self.companyId })
              .then(function(sch){ self.cached_schedule = sch; return Promise.resolve(sch) });
          }

          // there are two schedules, presumably one company wide and another
          // is user specific, return later one
          if (schedules.length === 2) {
            return Promise.resolve(
              _.find(schedules, function(sch){ return sch.is_user_specific() })
            )
            .then(function(sch){ self.cached_schedule = sch; return Promise.resolve(sch) });
          }

          // single schedule means it is company wide one
          return Promise.resolve( schedules.pop() )
            .then(function(sch){ self.cached_schedule = sch; return Promise.resolve(sch) });
        });
    },

  };

};

function get_class_methods(sequelize) {
  return {

    /* hashify_password( password_string ) : string
     *
     * Hash a plain-text password for storage using a per-user salt (scrypt).
     *
     * */
    hashify_password : function( password ) {
      return passwordHasher.hashPassword( password );
    },

    /* hashify_password_legacy( password_string ) : string
     *
     * Legacy unsalted MD5 hashing. Kept ONLY to verify (and then transparently
     * upgrade) passwords stored by releases prior to scrypt. Never used to
     * produce new hashes.
     *
     * */
    hashify_password_legacy : function( password ) {
      return crypto
        .createHash('md5')
        .update(
          password + config.get('crypto_secret'),
          (config.get('crypto_hash_encoding') || 'binary')
        )
        .digest('hex');
    },


    get_user_by_reset_password_token : function(token) {
      var self = this;
      const decoded = decodePasswordResetToken(token);

      if (!decoded) {
        return Promise.resolve();
      }

      return self.find_by_email(decoded.payload.email)
        .then(function(user){
          const payload = user && verifyPasswordResetToken({
            token,
            passwordHash: user.password,
            secret: config.get('crypto_secret'),
          });

          if (payload) {
            return Promise.resolve(user);
          } else {
            return Promise.resolve();
          }
        })
    },

    // Get active user by provided email address
    find_by_email : function( email ) {

      // TODO validate email

      return this.findOne({
        where : {
          [Op.and] : [
            { email : email },
            this.get_active_user_filter(),
          ],
        },
      });
    },

    find_by_id : function(id) {
      return this.findOne({ where : {id : id}});
    },

    /*
     * Create new admin user within new environment - company etc
     * */
    register_new_admin_user : function(attributes){

      // TODO add parameters validation

      // Make sure we hash the password before storing it to DB
      attributes.password = this.hashify_password(attributes.password);

      var new_departments,
          new_user,
          country_code = attributes.country_code,
          timezone     = attributes.timezone,
          company_name = attributes.company_name;

      delete attributes.company_name;
      delete attributes.country_code;

      return sequelize.models.User.find_by_email( attributes.email )
        .then(function(existing_user){
          if (existing_user) {
            const error = new Error('Email is already used')
            error.show_to_user = true;
            throw error;
          }

          if (attributes.name.toLowerCase().indexOf('http') >= 0) {
            const error = new Error('Name cannot have links');
            error.show_to_user = true;
            throw error;
          }

          return sequelize.models.Company
            .create_default_company({
              name         : company_name,
              country_code : country_code,
              timezone     : timezone,
            });
        })

        // Make sure new user is going to be linked with a company
        .then(function(company){

          attributes.companyId = company.id;
          attributes.admin     = true;

          return company.getDepartments();
        })

        // Make sure new user is linked with department
        .then(function(departments){

          new_departments = departments;

          attributes.DepartmentId = departments[0].id;

          return sequelize.models.User.create( attributes );
        })

        // Make sure new departments know who is their boss
        .then(function(user){
          new_user = user;

          return Promise.all(_.map(new_departments, function(department){
            department.bossId = user.id;
            return department.save();
          }));
        })

        // Return promise with newly created user
        .then(function(){
          return Promise.resolve(new_user);
        });
    },

    /*
      The same question as is_active, asked in SQL.

      The boundary is passed in by callers that know whose company they are
      querying, so that a WHERE clause and the badge on the page agree about
      which day it is.

      It falls back to UTC because two callers cannot supply it: find_by_email
      is the login lookup and cannot know the company before it has found the
      user, and the 'active' scope is registered once for every caller there is.
      Those two are a day out at the edges of the company's day, which is what
      this whole comparison used to be everywhere.
    */
    get_active_user_filter : function(today){
      const boundary = today || moment.utc().startOf('day');

      return {
        [Op.or] : [
          { end_date : {[Op.eq] : null}},
          { end_date : {[Op.gte] : boundary.format('YYYY-MM-DD') }},
        ],
      };
    },

  };
}; // END of class methods


// Mixin-like function that injects definition of User's associations into supplied object.
// (Define relations between User class and other entities in the domain).
//
function withAssociations() {

  this.associate = function(models){

    models.User.belongsTo(models.Company, {
      as : 'company',
    });
    models.User.belongsTo(models.Department, {
      as         : 'department',
      foreignKey : 'DepartmentId',
    });
    models.User.hasMany(models.Leave, {
      as         : 'my_leaves',
      foreignKey : 'userId',
    });
    models.User.hasMany(models.UserFeed, {
      as         : 'feeds',
      foreignKey : 'userId',
    });
    models.User.hasMany(models.UserAllowanceAdjustment, {
      as         : 'adjustments',
      foreignKey : 'user_id',
    });
    models.User.belongsToMany(models.Group, {
      as         : 'groups',
      through    : models.UserGroup,
      foreignKey : 'userId',
      otherKey   : 'groupId',
    });
  };
}


function withScopes() {

  this.loadScope = function(models) {

    models.User.addScope(
      'active',
      function () {
        return { where : models.User.get_active_user_filter() };
      }
    );

    models.User.addScope(
      'withDepartments',
      () => ({
        include: [{
          model: models.Department,
          as: 'department',
        }],
      })
    );

    models.User.addScope(
      'with_simple_leaves',
      () => ({
        include : [{
          model : models.Leave,
          as : 'my_leaves',
          where : {
            [Op.and] : [
              { status : { [Op.ne] : models.Leave.status_rejected() } },
              { status : { [Op.ne] : models.Leave.status_canceled() } },
            ],
          },
        }],
      })
    );

    models.User.addScope(
      'withGroups',
      () => ({
        include: [{
          model: models.Group,
          as: 'groups',
          through: { attributes: [] },
          required: false,
        }],
      })
    );

  };
}
