const test = require("node:test");
const assert = require("node:assert/strict");

const { processReminder } = require("../reminder_scheduler");

test("retries only the unfinished medicine-box channel", async () => {
  let phoneCalls = 0;
  let boxCalls = 0;

  const result = await processReminder({
    delivery: {
      phoneNotificationSent: true,
      medicineBoxRequired: true,
      medicineBoxCommandQueued: false,
    },
    medicineBoxRequired: true,
    sendPhone: async () => {
      phoneCalls++;
      return { successCount: 1 };
    },
    queueMedicineBox: async () => {
      boxCalls++;
      return { queued: true, deviceId: "box-1" };
    },
  });

  assert.equal(phoneCalls, 0);
  assert.equal(boxCalls, 1);
  assert.equal(result.phoneNotificationSent, true);
  assert.equal(result.medicineBoxCommandQueued, true);
  assert.equal(result.completed, true);
});

test("keeps the phone channel pending when FCM has zero successes", async () => {
  const result = await processReminder({
    delivery: {},
    medicineBoxRequired: false,
    sendPhone: async () => ({ successCount: 0, failureCount: 2 }),
    queueMedicineBox: async () => {
      throw new Error("box should not be called");
    },
  });

  assert.equal(result.phoneNotificationSent, false);
  assert.equal(result.completed, false);
  assert.deepEqual(result.errors, ["phone:no_successful_tokens"]);
});

test("treats a disabled buzzer as a non-required channel", async () => {
  const result = await processReminder({
    delivery: {},
    medicineBoxRequired: true,
    sendPhone: async () => ({ successCount: 1, failureCount: 0 }),
    queueMedicineBox: async () => ({
      queued: false,
      reason: "buzzer_disabled",
    }),
  });

  assert.equal(result.phoneNotificationSent, true);
  assert.equal(result.medicineBoxRequired, false);
  assert.equal(result.medicineBoxCommandQueued, false);
  assert.equal(result.completed, true);
  assert.deepEqual(result.errors, []);
});

test("keeps a failed medicine-box channel pending without repeating phone", async () => {
  const result = await processReminder({
    delivery: { phoneNotificationSent: true },
    medicineBoxRequired: true,
    sendPhone: async () => {
      throw new Error("phone should not be called");
    },
    queueMedicineBox: async () => ({
      queued: false,
      reason: "device_not_registered",
    }),
  });

  assert.equal(result.phoneNotificationSent, true);
  assert.equal(result.medicineBoxCommandQueued, false);
  assert.equal(result.completed, false);
  assert.deepEqual(result.errors, ["medicine_box:device_not_registered"]);
});
