const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildMedicineReminderMessage,
  buildMedicineCreatedMessage,
  buildMedicineOverdueMessage,
} = require("../notification_payload");

test("medicine reminder uses an Android system notification payload", () => {
  const message = buildMedicineReminderMessage({
    tokens: ["token-1", "token-1"],
    title: "服藥提醒：測試藥",
    body: "時間 10:30，請記得服藥",
    data: {
      patientId: "patient-1",
      reminderKey: "reminder-1",
    },
  });

  assert.deepEqual(message.notification, {
    title: "服藥提醒：測試藥",
    body: "時間 10:30，請記得服藥",
  });
  assert.equal(message.android.priority, "high");
  assert.equal(message.android.notification.channelId, "medicine_fcm_channel_v6");
  assert.equal(message.android.notification.sound, "default");
  assert.equal(message.android.notification.priority, "max");
  assert.equal(message.android.notification.visibility, "public");
  assert.deepEqual(
    message.android.notification.vibrateTimingsMillis,
    [0, 800, 300, 800, 300, 1200]
  );
  assert.equal(message.data.type, "medicine_reminder");
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
    data: { reminderKey: "reminder-1", repeatCount: 1 },
  });

  assert.equal(message.data.type, "medicine_overdue_reminder");
  assert.equal(message.data.repeatCount, "1");
  assert.equal(message.android.notification.channelId, "medicine_fcm_channel_v6");
});
