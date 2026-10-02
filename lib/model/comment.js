
'use strict';

const
  Models = require('./db');

const commentLeave = ({leave, comment, companyId, transaction}) => {
  return Models.Comment.create({
    entityType: Models.Comment.getEntityTypeLeave(),
    entityId: leave.id,
    comment,
    companyId,
    byUserId: leave.userId,
  }, transaction ? {transaction} : undefined);
};

const getCommentsForLeave = ({leave}) => {
  return Models.Comment.findAll({
    raw: true,
    where : {
      entityType: Models.Comment.getEntityTypeLeave(),
      entityId: leave.id,
    },
  });
};

module.exports = {
  commentLeave,
  getCommentsForLeave,
};
