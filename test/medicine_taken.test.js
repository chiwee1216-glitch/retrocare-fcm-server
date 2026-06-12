const test = require("node:test");
const assert = require("node:assert/strict");

const {
  findNewTakenSlots,
  selectMedicineForTakenEvent,
} = require("../medicine_taken");

const now = new Date("2026-06-12T06:12:00.000Z");

test("detects only newly active taken slots", () => {
  assert.deepEqual(
    findNewTakenSlots({
      previousActiveSlots: ["早上格"],
      slots: [
        { slot: "早上格", taken: true },
        { slot: "中午格", taken: true },
        { slot: "晚上格", taken: false },
      ],
    }),
    {
      activeSlots: ["早上格", "中午格"],
      newTakenSlots: ["中午格"],
    }
  );
});

test("selects the nearest due unfinished medicine for the patient", () => {
  const selected = selectMedicineForTakenEvent({
    patientId: "patient-1",
    now,
    medicines: [
      {
        id: "old",
        patientId: "patient-1",
        isDone: false,
        scheduledAt: new Date("2026-06-12T05:00:00.000Z"),
      },
      {
        id: "nearest",
        patientId: "patient-1",
        isDone: false,
        scheduledAt: new Date("2026-06-12T06:10:00.000Z"),
      },
      {
        id: "future",
        patientId: "patient-1",
        isDone: false,
        scheduledAt: new Date("2026-06-12T06:15:00.000Z"),
      },
      {
        id: "wrong-patient",
        patientId: "patient-2",
        isDone: false,
        scheduledAt: new Date("2026-06-12T06:11:00.000Z"),
      },
    ],
  });

  assert.equal(selected.id, "nearest");
});

test("does not select completed, future, or ambiguous medicines", () => {
  assert.equal(
    selectMedicineForTakenEvent({
      patientId: "patient-1",
      now,
      medicines: [
        {
          id: "done",
          patientId: "patient-1",
          isDone: true,
          scheduledAt: new Date("2026-06-12T06:10:00.000Z"),
        },
        {
          id: "future",
          patientId: "patient-1",
          isDone: false,
          scheduledAt: new Date("2026-06-12T06:13:00.000Z"),
        },
      ],
    }),
    null
  );

  assert.equal(
    selectMedicineForTakenEvent({
      patientId: "patient-1",
      now,
      medicines: [
        {
          id: "a",
          patientId: "patient-1",
          isDone: false,
          scheduledAt: new Date("2026-06-12T06:10:00.000Z"),
        },
        {
          id: "b",
          patientId: "patient-1",
          isDone: false,
          scheduledAt: new Date("2026-06-12T06:10:00.000Z"),
        },
      ],
    }),
    null
  );
});
