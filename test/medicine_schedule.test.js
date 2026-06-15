const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildDailySchedules,
  buildNormalWindow,
  scheduleKey,
} = require("../medicine_schedule");

test("groups medicines by patient date and time and assigns four slots", () => {
  const schedules = buildDailySchedules([
    {
      id: "a",
      patientId: "p1",
      date: "2026/06/15",
      time: "14:00",
      name: "血壓藥",
    },
    {
      id: "b",
      patientId: "p1",
      date: "2026/06/15",
      time: "14:00",
      name: "胃藥",
    },
    {
      id: "c",
      patientId: "p1",
      date: "2026/06/15",
      time: "16:00",
      name: "降血糖藥",
    },
  ]);

  assert.equal(schedules.length, 2);
  assert.equal(schedules[0].slotIndex, 1);
  assert.deepEqual(schedules[0].medicineIds, ["a", "b"]);
  assert.equal(schedules[1].slotIndex, 2);
});

test("rejects a fifth distinct medicine time", () => {
  assert.throws(
    () =>
      buildDailySchedules([
        { id: "a", patientId: "p1", date: "2026/06/15", time: "08:00" },
        { id: "b", patientId: "p1", date: "2026/06/15", time: "10:00" },
        { id: "c", patientId: "p1", date: "2026/06/15", time: "12:00" },
        { id: "d", patientId: "p1", date: "2026/06/15", time: "14:00" },
        { id: "e", patientId: "p1", date: "2026/06/15", time: "16:00" },
      ]),
    /最多支援四個服藥時段/
  );
});

test("uses a ten minute normal window", () => {
  const window = buildNormalWindow("2026/06/15", "16:00");

  assert.equal(window.start.toISOString(), "2026-06-15T07:50:00.000Z");
  assert.equal(window.end.toISOString(), "2026-06-15T08:10:00.000Z");
});

test("builds a stable schedule key", () => {
  assert.equal(
    scheduleKey({
      patientId: "patient-1",
      date: "2026-06-15",
      time: "08:05",
    }),
    "patient-1:2026/06/15:08:05"
  );
});
