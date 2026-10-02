"use strict";

const tokenSecurity = require('../../auth/integration_api_token');

module.exports = function(sequelize, DataTypes) {
  const UserFeed = sequelize.define("UserFeed", {
    name : {
      type : DataTypes.STRING,
      allowNull : false,
    },
    feed_token : {
      type      : DataTypes.STRING,
      allowNull : false,
    },
    type : {
      // NOTE: 'wallchart' and 'teamview' are essentially the same thing
      // later one used to be know as former, from now on use 'teamview'
      // and keep old what for data compatibility
      type      : DataTypes.ENUM('calendar', 'wallchart', 'teamview', 'company'),
      allowNull : false,
    },
  }, {

    

    
  });

  
    UserFeed.associate = function( models ) {
        UserFeed.belongsTo(models.User, {as : 'user'});
      };

    // The column stores the SHA-256 digest of the token (see migration
    // 20261002140000); the raw token exists only in the returned instance's
    // raw_token for the single response that creates or rotates the feed.
    UserFeed.promise_new_feed = function(args){
        const self = this,
            user = args.user,
            type = args.type,
            raw_token = tokenSecurity.generateToken(),
            feed_token = tokenSecurity.hashToken(raw_token);

        return self
          .findOne({ where : {userId : user.id, type : type} })
          .then(function(feed){
            if ( feed ) {
              feed.feed_token = feed_token;
              return feed.save();
            } 
              return self.create({
                name       : "Calendar Feed",
                feed_token : feed_token,
                type       : type,
                userId     : user.id,
              });
            
          })
          .then(function(feed){
            feed.raw_token = raw_token;
            return feed;
          })
      };

    UserFeed.prototype.is_calendar = function() {
        return this.type === 'calendar';
      };

    UserFeed.prototype.is_team_view = function(){
        return this.type === 'wallchart' || this.type === 'teamview';
      };

return UserFeed;
};
