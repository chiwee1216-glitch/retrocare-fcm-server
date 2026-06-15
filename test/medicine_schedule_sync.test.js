const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildScheduleAssignments,
} = require("../medicine_schedule");

test("assigns same-time medicines to one schedule and slot", () => {
  const result = buildScheduleAssignments([
    {
      id: "m1",
      patientId: "p1",
      date: "2026/06/15",
      time: "08:00",
      name: "A",
    },
    {
      id: "m2",
      patientId: "p1",
      date: "2026/06/15",
      time: "08:00",
      name: "B",
    },
    {
      id: "m3",
      patientId: "p1",
      date: "2026/06/15",
      time: "18:00",
      name: "C",
    },
  ]);

  assert.equal(result.schedules.length, 2);
  assert.equal(result.schedules[0].slotIndex, 1);
  assert.deepEqual(result.schedules[0].medicineIds, ["m1", "m2"]);
  assert.equal(result.medicineUpdates[0].scheduleId, result.medicineUpdates[1].scheduleId);
  assert.equal(result.medicineUpdates[2].slotIndex, 2);
});

test("reorders slot indexes when a medicine time changes", () => {
  const result = buildScheduleAssignments([
    {
      id: "late",
      patientId: "p1",
      date: "2026/06/15",
      time: "20:00",
    },
    {
      id: "early",
      patientId: "p1",
      date: "2026/06/15",
      time: "07:00",
    },
  ]);

  assert.equal(result.schedules[0].medicineIds[0], "early");
  assert.equal(result.schedules[0].slotIndex, 1);
  assert.equal(result.schedules[1].medicineIds[0], "late");
  assert.equal(result.schedules[1].slotIndex, 2);
});
