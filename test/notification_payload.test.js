const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildMedicineReminderMessage,
  buildMedicineCreatedMessage,
  buildMedicineExceptionMessage,
  buildMedicineOverdueMessage,
  buildMedicineRefillMessage,
} = require("../notification_payload");

test("medicine reminder uses a high-priority data-only payload", () => {
  const message = buildMedicineReminderMessage({
    tokens: ["token-1", "token-1"],
    title: "服藥提醒：測試藥",
    body: "時間 10:30，請記得服藥",
    data: {
      patientId: "patient-1",
      reminderKey: "reminder-1",
      reminderCycleKey: "reminder-1:initial",
    },
  });

  assert.equal(message.notification, undefined);
  assert.equal(message.android.priority, "high");
  assert.equal(message.android.notification, undefined);
  assert.equal(message.data.type, "medicine_reminder");
  assert.equal(message.data.title, "服藥提醒：測試藥");
  assert.equal(message.data.body, "時間 10:30，請記得服藥");
  assert.equal(message.data.reminderCycleKey, "reminder-1:initial");
  assert.deepEqual(message.tokens, ["token-1"]);
});

test("medicine-created notification is data-only so the app controls vibration", () => {
  const message = buildMedicineCreatedMessage({
    tokens: ["token-1"],
    title: "已新增服藥提醒：測試藥",
    body: "2026/06/12，時間：10:30",
    data: {
      patientId: "patient-1",
      medicineName: "測試藥",
    },
  });

  assert.equal(message.notification, undefined);
  assert.equal(message.android.priority, "high");
  assert.equal(message.data.type, "medicine_created");
});

test("overdue reminder has its own notification type", () => {
  const message = buildMedicineOverdueMessage({
    tokens: ["token-1"],
    title: "未服藥提醒",
    body: "請儘快服藥",
    data: {
      reminderKey: "reminder-1",
      reminderCycleKey: "reminder-1:repeat-1",
      repeatCount: 1,
    },
  });

  assert.equal(message.notification, undefined);
  assert.equal(message.android.notification, undefined);
  assert.equal(message.data.type, "medicine_overdue_reminder");
  assert.equal(message.data.repeatCount, "1");
  assert.equal(
    message.data.reminderCycleKey,
    "reminder-1:repeat-1"
  );
});

test("exception and refill payloads include a stable event key", () => {
  const exception = buildMedicineExceptionMessage({
    tokens: ["token-1"],
    title: "異常取藥",
    body: "請看護確認",
    data: { eventKey: "exception-1" },
  });
  const refill = buildMedicineRefillMessage({
    tokens: ["token-1"],
    title: "請補藥",
    body: "第 1 格尚未補藥",
    data: { eventKey: "refill-1" },
  });

  assert.equal(exception.data.type, "medicine_exception");
  assert.equal(exception.data.eventKey, "exception-1");
  assert.equal(refill.data.type, "medicine_refill_missing");
  assert.equal(refill.data.eventKey, "refill-1");
});
