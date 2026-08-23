/*
 *
 * */

"use strict";

const express = require('express');
const router  = express.Router();

router.get('/', function(req, res) {

    const user = req.user;

    req.session.keep_old();

    // if no user available in session show main public
    if (!user) {
      return res.redirect_with_session('./login/');
    }

    return res.redirect_with_session('./calendar/');
});

// Make sure that all fallowing handlers Dashboard
// require authenticated users
router.all(/.*/, function (req, res, next) {

    if ( !req.user ) {
        return res.redirect_with_session(303, '/');
    }

    return next();
});

router.get('/foo/', function(_req, res) {

    res.render('dashboard', { title: _req.t('titles.dashboard') });
});


module.exports = router;
