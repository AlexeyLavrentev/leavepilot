
"use strict";

/*
  Because a bug in express-session middleware, when working
  with async stores we need explicitly wait until session
  changes are saved before proceeding farther, otherwise
  user ends up on next page quicker than session storage saves
  changes.

  More details are here: https://github.com/expressjs/session/pull/69

  Add new special redirect function to the res object to be session aware.

  TODO: Consider to completly substitute redirect function with new logic.
*/

/*
  Only same-origin targets may reach res.redirect. An absolute URL or a
  protocol-relative prefix points off-origin; a backslash anywhere is
  normalized to a slash by browsers and turns '/\evil.example' into
  '//evil.example'. Relative paths like '../' can never leave the origin and
  stay allowed. CRLF does not need a check here: res.setHeader rejects it.
*/
const isSafeRelativeTarget = function(value){
  return typeof value === 'string'
    && value.length > 0
    && !/^[a-z][a-z0-9+.-]*:/i.test(value)
    && !/^[/\\]{2}/.test(value)
    && !value.includes('\\');
};

module.exports = function(req, res, next){

   // Two call shapes: (url) and (status, url). The safety net applies to the
   // URL argument only; the status passes through untouched.
   res.redirect_with_session = function(a,b){
        const hasStatus = arguments.length === 2;
        const url = isSafeRelativeTarget(hasStatus ? b : a) ? (hasStatus ? b : a) : '../';

        req.session.save(function(){
            if (hasStatus) {
                res.redirect(a, url);
            } else {
                res.redirect(url);
            }
        });
        return true;
    };

    next();
};

module.exports.isSafeRelativeTarget = isSafeRelativeTarget;
