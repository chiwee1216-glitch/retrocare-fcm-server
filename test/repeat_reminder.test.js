const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCycleDeliveryState,
  prepareCycleDelivery,
  getReminderCycle,
  isRepeatReminderEligible,
  shouldClaimCycle,
} = require("../repeat_reminder");

const scheduledAt = new Date("2026-06-12T06:00:00.000Z");

test("uses fixed five-minute reminder cycles", () => {
  assert.deepEqual(
    getReminderCycle({
      scheduledAt,
      now: new Date("2026-06-12T06:00:00.000Z"),
      isDone: false,
    }),
    { cycleKey: "initial", repeatCount: 0, dueAt: scheduledAt }
  );
  assert.equal(
    getReminderCycle({
      scheduledAt,
      now: new Date("2026-06-12T06:04:59.000Z"),
      isDone: false,
    }).cycleKey,
    "initial"
  );
  assert.equal(
    getReminderCycle({
      scheduledAt,
      now: new Date("2026-06-12T06:05:00.000Z"),
      isDone: false,
    }).cycleKey,
    "repeat-1"
  );
  assert.equal(
    getReminderCycle({
      scheduledAt,
      now: new Date("2026-06-12T06:10:00.000Z"),
      isDone: false,
    }).cycleKey,
    "repeat-2"
  );
});

test("continues reminder cycles across midnight", () => {
  const cycle = getReminderCycle({
    scheduledAt: new Date("2026-06-12T15:58:00.000Z"),
    now: new Date("2026-06-12T16:08:00.000Z"),
    isDone: false,
  });

  assert.equal(cycle.cycleKey, "repeat-2");
  assert.equal(cycle.repeatCount, 2);
});

test("does not produce cycles before schedule or after completion", () => {
  assert.equal(
    getReminderCycle({
      scheduledAt,
      now: new Date("2026-06-12T05:59:59.000Z"),
      isDone: false,
    }),
    null
  );
  assert.equal(
    getReminderCycle({ scheduledAt, now: scheduledAt, isDone: true }),
    null
  );
});

test("claims a new cycle or an unfinished current cycle only", () => {
  assert.equal(shouldClaimCycle({}, "initial"), true);
  assert.equal(
    shouldClaimCycle(
      { currentCycleKey: "initial", currentCycleCompleted: false },
      "initial"
    ),
    true
  );
  assert.equal(
    shouldClaimCycle(
      { currentCycleKey: "initial", currentCycleCompleted: true },
      "initial"
    ),
    false
  );
  assert.equal(
    shouldClaimCycle(
      { currentCycleKey: "initial", currentCycleCompleted: true },
      "repeat-1"
    ),
    true
  );
});

test("resets channel state only when entering a new cycle", () => {
  assert.deepEqual(
    prepareCycleDelivery(
      {
        currentCycleKey: "initial",
        currentCyclePhoneSent: true,
        currentCycleMedicineBoxQueued: false,
        medicineBoxRequired: true,
      },
      "initial"
    ),
    {
      phoneNotificationSent: true,
      medicineBoxCommandQueued: false,
      medicineBoxRequired: true,
    }
  );

  assert.deepEqual(
    prepareCycleDelivery(
      {
        currentCycleKey: "initial",
        currentCyclePhoneSent: true,
        currentCycleMedicineBoxQueued: true,
        medicineBoxRequired: true,
      },
      "repeat-1"
    ),
    {
      phoneNotificationSent: false,
      medicineBoxCommandQueued: false,
      medicineBoxRequired: true,
    }
  );
});

test("stores a completed cycle while keeping the reminder active", () => {
  const state = buildCycleDeliveryState({
    cycle: {
      cycleKey: "repeat-2",
      repeatCount: 2,
      dueAt: new Date("2026-06-12T06:10:00.000Z"),
    },
    result: {
      phoneNotificationSent: true,
      medicineBoxRequired: true,
      medicineBoxCommandQueued: true,
      completed: true,
      errors: [],
    },
  });

  assert.equal(state.reminderState, "pending");
  assert.equal(state.currentCycleKey, "repeat-2");
  assert.equal(state.currentCycleCompleted, true);
  assert.equal(state.currentCyclePhoneSent, true);
  assert.equal(state.currentCycleMedicineBoxQueued, true);
  assert.equal(state.repeatCount, 2);
  assert.equal(
    state.nextRepeatAt.toISOString(),
    "2026-06-12T06:15:00.000Z"
  );
});

test("does not activate repeating reminders for pre-rollout legacy data", () => {
  assert.equal(
    isRepeatReminderEligible(
      new Date("2026-05-19T02:43:00.000Z")
    ),
    false
  );
  assert.equal(
    isRepeatReminderEligible(
      new Date("2026-06-11T16:00:00.000Z")
    ),
    true
  );
});
