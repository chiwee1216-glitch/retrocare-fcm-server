const test = require("node:test");
const assert = require("node:assert/strict");

const { planTokenOwnership } = require("../fcm_token_ownership");

test("moves a device token away from every inactive account", () => {
  const plan = planTokenOwnership({
    activeUserId: "caregiver-1",
    token: "phone-token",
    previousToken: "",
    matchingUserIds: ["patient-1", "caregiver-1"],
    previousTokenUserIds: [],
  });

  assert.deepEqual(plan.removeFromUserIds, ["patient-1"]);
  assert.equal(plan.addToUserId, "caregiver-1");
});

test("removes a rotated token before assigning the current token", () => {
  const plan = planTokenOwnership({
    activeUserId: "patient-1",
    token: "new-token",
    previousToken: "old-token",
    matchingUserIds: [],
    previousTokenUserIds: ["patient-1", "caregiver-1"],
  });

  assert.deepEqual(plan.removePreviousFromUserIds, [
    "patient-1",
    "caregiver-1",
  ]);
  assert.equal(plan.addToUserId, "patient-1");
});
