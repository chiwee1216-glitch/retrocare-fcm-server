const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyPackageRemoved,
  normalizeSlotIndex,
  shouldProcessEvent,
} = require("../medicine_box_event");
const { buildNormalWindow } = require("../medicine_schedule");

function schedule({
  id,
  slotIndex,
  date = "2026/06/15",
  time = "16:00",
  status = "scheduled",
}) {
  const window = buildNormalWindow(date, time);
  return {
    id,
    slotIndex,
    status,
    normalWindowStart: window.start,
    normalWindowEnd: window.end,
  };
}

test("completes only the schedule assigned to the removed slot", () => {
  const result = classifyPackageRemoved({
    slotIndex: 2,
    occurredAt: new Date("2026-06-15T08:05:00.000Z"),
    schedules: [
      schedule({ id: "s1", slotIndex: 1 }),
      schedule({ id: "s2", slotIndex: 2 }),
    ],
  });

  assert.equal(result.kind, "normal");
  assert.equal(result.scheduleId, "s2");
});

test("marks an outside-window removal as an exception", () => {
  const result = classifyPackageRemoved({
    slotIndex: 3,
    occurredAt: new Date("2026-06-15T08:20:00.000Z"),
    schedules: [schedule({ id: "s3", slotIndex: 3 })],
  });

  assert.equal(result.kind, "exception");
  assert.equal(result.reason, "outside_normal_window");
  assert.equal(result.scheduleId, "s3");
});

test("marks an unassigned slot as an exception", () => {
  const result = classifyPackageRemoved({
    slotIndex: 4,
    occurredAt: new Date("2026-06-15T08:00:00.000Z"),
    schedules: [schedule({ id: "s2", slotIndex: 2 })],
  });

  assert.deepEqual(result, {
    kind: "exception",
    reason: "unassigned_slot",
    scheduleId: "",
  });
});

test("does not match a completed or pending-exception schedule", () => {
  for (const status of ["completed", "exception_pending"]) {
    const result = classifyPackageRemoved({
      slotIndex: 2,
      occurredAt: new Date("2026-06-15T08:00:00.000Z"),
      schedules: [schedule({ id: "s2", slotIndex: 2, status })],
    });

    assert.equal(result.reason, "unassigned_slot");
  }
});

test("deduplicates repeated firmware event ids", () => {
  assert.equal(
    shouldProcessEvent({
      eventId: "boot1-42",
      processedEventIds: ["boot1-42"],
    }),
    false
  );
  assert.equal(
    shouldProcessEvent({ eventId: "boot1-43", processedEventIds: ["boot1-42"] }),
    true
  );
});

test("normalizes new and legacy slot labels", () => {
  assert.equal(normalizeSlotIndex({ slotIndex: 3 }), 3);
  assert.equal(normalizeSlotIndex({ slot: "第 4 格" }), 4);
  assert.equal(normalizeSlotIndex({ slot: "早上格" }), 1);
  assert.equal(normalizeSlotIndex({ slot: "睡前格" }), 4);
  assert.equal(normalizeSlotIndex({ slot: "未知" }), null);
});
