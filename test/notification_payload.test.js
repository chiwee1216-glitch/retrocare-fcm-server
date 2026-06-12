const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildMedicineReminderMessage,
  buildMedicineCreatedMessage,
  buildMedicineOverdueMessage,
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

test("medicine-created notification also displays while the app is closed", () => {
  const message = buildMedicineCreatedMessage({
    tokens: ["token-1"],
    title: "已新增服藥提醒：測試藥",
    body: "2026/06/12，時間：10:30",
    data: {
      patientId: "patient-1",
      medicineName: "測試藥",
    },
  });

  assert.equal(message.notification.title, "已新增服藥提醒：測試藥");
  assert.equal(message.android.notification.channelId, "medicine_fcm_channel_v6");
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
