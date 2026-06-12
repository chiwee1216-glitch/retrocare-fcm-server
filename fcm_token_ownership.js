function uniqueUserIds(userIds) {
  return [...new Set(userIds.filter(Boolean))];
}

function planTokenOwnership({
  activeUserId,
  token,
  previousToken,
  matchingUserIds,
  previousTokenUserIds,
}) {
  return {
    token,
    previousToken,
    addToUserId: activeUserId,
    removeFromUserIds: uniqueUserIds(matchingUserIds).filter(
      (userId) => userId !== activeUserId
    ),
    removePreviousFromUserIds: previousToken
      ? uniqueUserIds(previousTokenUserIds)
      : [],
  };
}

module.exports = {
  planTokenOwnership,
};
