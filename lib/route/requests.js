
"use strict";

const express   = require('express'),
    router    = express.Router(),
    validator = require('../util/validator'),
    _         = require('underscore'),
    dayjs    = require('../util/date'),
    log      = require('../logger'),
    LeaveCollectionUtil = require('../model/leave_collection')(),
    deliveryOutbox      = require('../model/delivery_outbox'),
    pMap                = require('p-map').default;

const { getMinimumLeaveRequirementStatus } = require('../model/leave/minimum_leave_requirement');

router.get('/', function(req, res){
  const dbModel = req.app.get('db_model');

  Promise.all([
    req.user
      .promise_my_active_leaves_ever()
      .then(leaves => LeaveCollectionUtil.enrichLeavesWithComments({leaves, dbModel}))
      .then(leaves => LeaveCollectionUtil.promise_to_group_leaves(leaves)),
    req.user
      .promise_leaves_to_be_processed()
      .then(leaves => LeaveCollectionUtil.enrichLeavesWithComments({leaves, dbModel})),
  ]).then(function([my_leaves_grouped, to_be_approved_leaves]){
      return pMap(
          to_be_approved_leaves,
          async leave => {
            const warningStatus = await getMinimumLeaveRequirementStatus({
              user      : leave.user,
              leaveType : leave.leave_type,
              year      : dayjs.utc(leave.date_start),
            });

            if (warningStatus) {
              leave.minimum_leave_warning = req.t('leaveWarnings.managerMissingMinimumBlock', {
                year      : warningStatus.year,
                days      : warningStatus.requiredDays,
                leaveType : leave.leave_type.name,
              });
            }

            return leave;
          },
          { concurrency : 5 }
        )
        .then(() => {
          res.render('requests',{
            title                 : req.t('requests.messagesTitle', {
              name     : req.user.name,
              lastname : req.user.lastname,
            }),
            my_leaves_grouped     : my_leaves_grouped,
            to_be_approved_leaves : to_be_approved_leaves,
          });
        });
    }
  );
});

// Apply a decision (approve/reject) to a single leave that is among those the
// current user is allowed to process. The decision and its typed
// delivery-outbox records (email + edition event) commit as ONE transaction;
// delivery itself runs in the background afterwards. Returns the reloaded,
// processed leave — resolving means the decision is committed, anything
// thrown means the whole unit rolled back.
//
// Shared by the single-request handlers and the bulk handler so both paths
// stay in sync.
function process_single_decision({ req, leave_to_process, current_action, leave_action_method }) {
  const was_pended_revoke = leave_to_process.is_pended_revoke_leave();
  const db_model = req.app.get('db_model');

  // Commit unit (D-01/D-09): the leave change, the reload that feeds the
  // response, and the two outbox records commit or roll back together.
  // Every statement carries the explicit {transaction} (no CLS), and
  // nothing here awaits delivery — the response never depends on it
  // (D-02/D-06).
  return db_model.sequelize.transaction(async t => {
    const processed_leave = await leave_to_process[leave_action_method]({
      by_user     : req.user,
      transaction : t,
    });

    const reloaded_leave = await processed_leave.reload({
      include : [
        {model : db_model.User, as : 'user'},
        {model : db_model.User, as : 'approver'},
        {model : db_model.LeaveType, as : 'leave_type' },
      ],
      transaction : t,
    });

    await deliveryOutbox.enqueue({
      models      : db_model,
      transaction : t,
      records     : [
        {
          deliveryType : 'email',
          eventType    : current_action,
          companyId    : reloaded_leave.user.companyId,
          userId       : req.user.id,
          payload      : {
            leaveId         : reloaded_leave.id,
            action          : current_action,
            wasPendedRevoke : was_pended_revoke,
          },
        },
        {
          deliveryType : 'edition_event',
          eventType    : current_action,
          companyId    : reloaded_leave.user.companyId,
          userId       : req.user.id,
          payload      : {leaveId : reloaded_leave.id},
        },
      ],
    });

    return reloaded_leave;
  });
}

function leave_request_action(args) {
    const
      current_action      = args.action,
      leave_action_method = args.leave_action_method;

    return function(req, res){

    const request_id = validator.trim( req.body.request );

    if (!validator.isNumeric(request_id)){
      req.session.flash_error(req.t(`requests.messages.${current_action}Failed`));
    }

    if ( req.session.flash_has_errors() ) {
      log.error('Got validation errors on '+current_action+' request handler');

      return res.redirect_with_session('../');
    }

    return Promise.resolve().then(function(){
      return req.user.promise_leaves_to_be_processed();
    })
    .then(function(leaves){
       const leave_to_process = _.find(leaves, function(leave){
          return String(leave.id) === String(request_id)
            && (leave.is_new_leave() || leave.is_pended_revoke_leave());
       });

       if (! leave_to_process) {
         throw new Error('Provided ID '+request_id
           +'does not correspond to any leave requests to be '+current_action
           +'ed for user ' + req.user.id
          );
       }

       return process_single_decision({
         req,
         leave_to_process,
         current_action,
         leave_action_method,
       });
    })
    .then(async function(processed_leave){
      req.session.flash_message(req.t('requests.messages.processed', {
        name: processed_leave.user.full_name()
      }));

      return res.redirect_with_session('../');
    })
    .catch(function(error){
      log.error('An error occurred when attempting to '+current_action
        +' leave request '+request_id+' by user '+req.user.id+' Error: '+error
      );
      req.session.flash_error(req.t(`requests.messages.${current_action}Failed`));
      return res.redirect_with_session('../');
    });
  };

}

// Handle approving/rejecting several pending requests in one submit. The
// employee checkboxes post a list of leave ids under `request`; we process each
// id that genuinely belongs to the approver's pending queue and report a single
// summary message.
function leave_request_bulk_action(args) {
  const
    current_action      = args.action,
    leave_action_method = args.leave_action_method;

  return function(req, res){

    let raw_ids = req.body.request;

    // A single checkbox posts a scalar; normalise to an array.
    if (raw_ids === undefined) {raw_ids = [];}
    if (!Array.isArray(raw_ids)) {raw_ids = [raw_ids];}

    const request_ids = _.uniq(
      raw_ids
        .map(function(id){ return validator.trim(String(id)); })
        .filter(function(id){ return validator.isNumeric(id); })
    );

    if (request_ids.length === 0) {
      req.session.flash_error(req.t('requests.messages.bulkNoneSelected'));
      return res.redirect_with_session('/requests/');
    }

    let processed_count = 0;
    let failed_count    = 0;

    return Promise.resolve().then(function(){
      return req.user.promise_leaves_to_be_processed();
    })
    .then(function(leaves){
      const pending_by_id = {};
      leaves.forEach(function(leave){
        if (leave.is_new_leave() || leave.is_pended_revoke_leave()) {
          pending_by_id[String(leave.id)] = leave;
        }
      });

      // Process sequentially to keep email/event dispatch ordering predictable
      // and avoid hammering the DB connection pool.
      return request_ids.reduce(function(promise, request_id){
        return promise.then(function(){
        const leave_to_process = pending_by_id[String(request_id)];

        if (! leave_to_process) {
          failed_count += 1;
          log.error('Bulk '+current_action+': id '+request_id
            +' is not among requests user '+req.user.id+' can process; skipping');
          return Promise.resolve();
        }

        return process_single_decision({
          req,
          leave_to_process,
          current_action,
          leave_action_method,
        })
        .then(function(){
          processed_count += 1;
        })
        .catch(function(error){
          failed_count += 1;
          log.error('Bulk '+current_action+' failed for leave '+request_id
            +' by user '+req.user.id+' Error: '+error);
        });
        });
      }, Promise.resolve());
    })
    .then(async function(){
      if (processed_count > 0) {
        req.session.flash_message(req.t('requests.messages.bulkProcessed', {
          count  : processed_count,
          action : req.t(`requests.${current_action}`),
        }));
      }
      if (failed_count > 0) {
        req.session.flash_error(req.t('requests.messages.bulkFailed', {
          count : failed_count,
        }));
      }

      return res.redirect_with_session('/requests/');
    })
    .catch(function(error){
      log.error('An error occurred during bulk '+current_action
        +' by user '+req.user.id+' Error: '+error);
      req.session.flash_error(req.t(`requests.messages.${current_action}Failed`));
      return res.redirect_with_session('/requests/');
    });
  };
}

router.post(
  '/reject/',
  leave_request_action({
    action              : 'reject',
    leave_action_method : 'promise_to_reject',
  })
);

router.post(
  '/approve/',
  leave_request_action({
    action              : 'approve',
    leave_action_method : 'promise_to_approve',
  })
);

router.post(
  '/bulk/reject/',
  leave_request_bulk_action({
    action              : 'reject',
    leave_action_method : 'promise_to_reject',
  })
);

router.post(
  '/bulk/approve/',
  leave_request_bulk_action({
    action              : 'approve',
    leave_action_method : 'promise_to_approve',
  })
);

router.post('/cancel/', function(req, res){

  const request_id = validator.trim( req.body.request );

  Promise.resolve().then(function(){
    return req.user.promise_cancelable_leaves()
  })
  .then(function(leaves){
     const leave_to_cancel = _.find(leaves, function(leave){
        return String(leave.id) === String(request_id);
     });

    if ( ! leave_to_cancel ) {
      throw new Error('Given leave request is not amoung those current user can cancel');
    }

    return Promise.resolve(leave_to_cancel);
  })
  .then(function(leave){
    const db_model = req.app.get('db_model');

    // Commit unit (D-01/D-09): the cancellation, its reload, and the two
    // outbox records commit or roll back together; delivery is a background
    // concern only (D-02/D-06). The catch below now fires for commit
    // failures only — that change IS MUT-01.
    return db_model.sequelize.transaction(async t => {
      await leave.promise_to_cancel({ transaction : t });

      const reloaded_leave = await leave.reload({
        include : [
          {model : db_model.User, as : 'user'},
          {model : db_model.User, as : 'approver'},
          {model : db_model.LeaveType, as : 'leave_type' },
        ],
        transaction : t,
      });

      await deliveryOutbox.enqueue({
        models      : db_model,
        transaction : t,
        records     : [
          {
            deliveryType : 'email',
            eventType    : 'cancel',
            companyId    : reloaded_leave.user.companyId,
            userId       : req.user.id,
            payload      : {leaveId : reloaded_leave.id},
          },
          {
            deliveryType : 'edition_event',
            eventType    : 'cancel',
            companyId    : reloaded_leave.user.companyId,
            userId       : req.user.id,
            payload      : {leaveId : reloaded_leave.id},
          },
        ],
      });

      return reloaded_leave;
    });
  })
  .then(async function(){
    req.session.flash_message(req.t('requests.messages.canceled'));
  })
  .catch(function(error){
    log.error('An error occurred: '+error);
    req.session.flash_error(req.t('requests.messages.cancelFailed'));
  })
  .finally(function(){
    return res.redirect_with_session('/requests/');
  });
});

router.post(
  '/revoke/',
  function(req, res){
    const request_id = validator.trim( req.body.request );

    // TODO NOTE revoke action now could be made from more then one place,
    // so make sure that user is redirected to correct place

    if (!validator.isNumeric(request_id)){
      req.session.flash_error(req.t('requests.messages.revokeFailed'));
    }

    if ( req.session.flash_has_errors() ) {
      log.error(
        'Got validation errors when revoking leave request for user ' + req.user.id
      );

      return res.redirect_with_session('../');
    }

    return Promise.resolve()
      // Get the Leave object for submitted ID
      .then(() => req.app.get('db_model').Leave.findOne({ where : { id : request_id }}))

      // Ensure that current user can act on this Leave object
      .then(requested_leave => {

        // Case when requested Leave is originated from current user
        if ( String(requested_leave.userId) === String(req.user.id) ) {
          return Promise.resolve( requested_leave )
        }

        // Case when requested Leave is originated from one of employees
        // current user can manage
        return req.user
          .promise_users_I_can_manage()
          .then(users => {
            if ( users.find(u => String(u.id) === String(requested_leave.userId)) ) {
              return Promise.resolve( requested_leave );
            }

            return Promise.resolve();
          });
      })

      .then(leave_to_process => {

        // Ensure the leave exists and belongs to someone this user may act for.
        // Whether its status allows a revoke at all is promise_to_revoke's own
        // guard, which every caller goes through.
        if (! leave_to_process) {
          throw new Error('Provided ID '+request_id
            +' does not correspond to any leave requests to be revoked by user '
            + req.user.id
           );
        }

        // Do the action. Commit unit (D-01/D-09): the revoke (its internal
        // reload and save are threaded onto the same transaction), the
        // reload that feeds the response, and the two outbox records commit
        // or roll back together; delivery is a background concern only
        // (D-02/D-06). The catch below now fires for commit failures only —
        // that change IS MUT-01.
        const db_model = req.app.get('db_model');

        return db_model.sequelize.transaction(async t => {
          const processed_leave = await leave_to_process.promise_to_revoke({
            transaction : t,
          });

          const reloaded_leave = await processed_leave.reload({
            include : [
              {model : db_model.User, as : 'user'},
              {model : db_model.User, as : 'approver'},
              {model : db_model.LeaveType, as : 'leave_type' },
            ],
            transaction : t,
          });

          await deliveryOutbox.enqueue({
            models      : db_model,
            transaction : t,
            records     : [
              {
                deliveryType : 'email',
                eventType    : 'revoke',
                companyId    : reloaded_leave.user.companyId,
                userId       : req.user.id,
                payload      : {leaveId : reloaded_leave.id},
              },
              {
                deliveryType : 'edition_event',
                eventType    : 'revoke',
                companyId    : reloaded_leave.user.companyId,
                userId       : req.user.id,
                payload      : {leaveId : reloaded_leave.id},
              },
            ],
          });

          return reloaded_leave;
        });
      })

      // Deal with next page: where to land and what to show
      .then(async processed_leave => {
        req.session.flash_message(processed_leave.is_auto_approve()
          ? req.t('requests.messages.revokeRequested')
          : req.t('requests.messages.revokeRequestedNeedsApproval')
        );

        return res.redirect_with_session('../');
      })

      // Deal with issues if any occurs
      .catch(error => {
        log.error('An error occurred when attempting to revoke leave request '
            +request_id+' by user '+req.user.id+' Error: '+error
        );
        req.session.flash_error(req.t('requests.messages.revokeFailed'));
        return res.redirect_with_session('../');
      });
  }
);

module.exports = router;
