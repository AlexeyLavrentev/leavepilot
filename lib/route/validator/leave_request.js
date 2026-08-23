
'use strict';

const validator = require('../../util/validator'),
    log = require('../../logger'),
    LeaveRequestParameters = require('../../model/leave_request_parameters');

module.exports = function(args){
    const req = args.req;

    const user           = validator.trim( req.body.user ),
        leave_type     = validator.trim( req.body.leave_type );
    let from_date      = validator.trim( req.body.from_date );
    const from_date_part = validator.trim( req.body.from_date_part );
    let to_date        = validator.trim( req.body.to_date );
    const to_date_part   = validator.trim( req.body.to_date_part ),
        reason         = validator.trim( req.body.reason );

    if (user && !validator.isNumeric(user)){
        req.session.flash_error(req.t('leaveRequest.messages.invalidEmployee'));
    }

    if (!validator.isNumeric(leave_type)){
        req.session.flash_error(req.t('leaveRequest.messages.invalidLeaveType'));
    }

    const date_validator = function(date_str, label) {
      try {

        // Basic check
        if (! date_str ) {throw new Error("date needs to be defined");}

        date_str = req.user.company.normalise_date(date_str);

        // Ensure that normalisation went OK
        if (! validator.isDate(date_str)) {throw new Error("Invalid date format");}

      } catch (e) {
        log.error('leave request date validation failed', { err: String(e) });
        req.session.flash_error(req.t('leaveRequest.messages.dateInvalid', {
          label: label
        }));
      }
    }

    date_validator(from_date, 'From date');

    if (  !validator.matches(from_date_part, /^[123]$/)
       || !validator.matches(to_date_part, /^[123]$/)
     ){
        req.session.flash_error(req.t('leaveRequest.messages.dayPartInvalid'));
    }

    date_validator(to_date, 'To date');

    // Check if it makes sence to continue validation (as following code relies on
    // to and from dates to be valid ones)
    if ( req.session.flash_has_errors() ) {
      throw new Error( 'Got validation errors' );
    }

    // Convert dates inot format used internally
    from_date = req.user.company.normalise_date(from_date);
    to_date = req.user.company.normalise_date(to_date);

    if ( req.session.flash_has_errors() ) {
      throw new Error( 'Got validation errors' );
    }

    const valid_attributes = {
        leave_type     : leave_type,
        from_date      : from_date,
        from_date_part : from_date_part,
        to_date        : to_date,
        to_date_part   : to_date_part,
        reason         : reason,
    };

    if ( user ) {
        valid_attributes.user = user;
    }

    return new LeaveRequestParameters( valid_attributes );
};
