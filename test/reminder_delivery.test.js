const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildReminderKey,
  isCronAuthorized,
  isDeliveryComplete,
  isExpired,
  requiredChannels,
  shouldAttemptMedicineBox,
  shouldAttemptPhone,
} = require("../reminder_delivery");

test("authorizes only an exact non-empty cron secret", () => {
  assert.equal(isCronAuthorized("same-secret", "same-secret"), true);
  assert.equal(isCronAuthorized("wrong", "same-secret"), false);
  assert.equal(isCronAuthorized("", ""), false);
});

test("builds a Firestore-safe daily reminder key", () => {
  assert.equal(
    buildReminderKey("med/1", "2026/06/12", "14:00"),
    "med_1_2026-06-12_14-00"
  );
});

test("does not require the medicine box when the buzzer is disabled", () => {
  assert.deepEqual(requiredChannels({ buzzerEnabled: false }), {
    phone: true,
    medicineBox: false,
  });
  assert.equal(
    isDeliveryComplete({
      phoneNotificationSent: true,
      medicineBoxRequired: false,
      medicineBoxCommandQueued: false,
    }),
    true
  );
});

test("retries only unfinished required channels", () => {
  const delivery = {
    phoneNotificationSent: true,
    medicineBoxRequired: true,
    medicineBoxCommandQueued: false,
  };

  assert.equal(shouldAttemptPhone(delivery), false);
  assert.equal(shouldAttemptMedicineBox(delivery), true);
});

test("expires only after the ten-minute delivery window", () => {
  assert.equal(isExpired({ nowMinutes: 850, medicineMinutes: 840 }), false);
  assert.equal(isExpired({ nowMinutes: 851, medicineMinutes: 840 }), true);
});
