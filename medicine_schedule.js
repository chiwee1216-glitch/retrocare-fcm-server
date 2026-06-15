const MAX_SLOT_COUNT = 4;
const NORMAL_WINDOW_MINUTES = 10;

function normalizeDate(value) {
  return String(value || "").trim().replace(/-/g, "/");
}

function scheduleKey({ patientId, date, time }) {
  return [
    String(patientId || "").trim(),
    normalizeDate(date),
    String(time || "").trim(),
  ].join(":");
}

function scheduleDocumentId(schedule) {
  return crypto
    .createHash("sha256")
    .update(scheduleKey(schedule))
    .digest("hex");
}

function buildScheduledAt(date, time) {
  const normalizedDate = normalizeDate(date).replace(/\//g, "-");
  const normalizedTime = String(time || "").trim();
  const value = new Date(`${normalizedDate}T${normalizedTime}:00+08:00`);

  if (Number.isNaN(value.getTime())) {
    throw new Error("服藥日期或時間格式錯誤");
  }

  return value;
}

function buildNormalWindow(date, time) {
  const scheduledAt = buildScheduledAt(date, time);
  const windowMillis = NORMAL_WINDOW_MINUTES * 60 * 1000;

  return {
    scheduledAt,
    start: new Date(scheduledAt.getTime() - windowMillis),
    end: new Date(scheduledAt.getTime() + windowMillis),
  };
}

function buildDailySchedules(medicines = []) {
  const groups = new Map();

  for (const medicine of medicines) {
    const key = scheduleKey(medicine);
    const group = groups.get(key) || {
      patientId: String(medicine.patientId || "").trim(),
      caregiverId: String(medicine.caregiverId || "").trim(),
      date: normalizeDate(medicine.date),
      time: String(medicine.time || "").trim(),
      medicineIds: [],
      medicineItems: [],
    };

    group.medicineIds.push(String(medicine.id || "").trim());
    group.medicineItems.push({
      id: String(medicine.id || "").trim(),
      name: String(medicine.name || "藥物"),
    });
    groups.set(key, group);
  }

  const schedules = [...groups.values()].sort((left, right) =>
    left.time.localeCompare(right.time)
  );

  if (schedules.length > MAX_SLOT_COUNT) {
    throw new Error("藥盒一天最多支援四個服藥時段");
  }

  return schedules.map((schedule, index) => {
    const window = buildNormalWindow(schedule.date, schedule.time);

    return {
      ...schedule,
      slotIndex: index + 1,
      status: "scheduled",
      scheduledAt: window.scheduledAt,
      normalWindowStart: window.start,
      normalWindowEnd: window.end,
    };
  });
}

function buildScheduleAssignments(medicines = []) {
  const schedules = buildDailySchedules(medicines).map((schedule) => ({
    ...schedule,
    id: scheduleDocumentId(schedule),
  }));
  const medicineUpdates = schedules.flatMap((schedule) =>
    schedule.medicineIds.map((medicineId) => ({
      medicineId,
      scheduleId: schedule.id,
      slotIndex: schedule.slotIndex,
    }))
  );

  return { schedules, medicineUpdates };
}

module.exports = {
  MAX_SLOT_COUNT,
  NORMAL_WINDOW_MINUTES,
  buildDailySchedules,
  buildNormalWindow,
  buildScheduleAssignments,
  buildScheduledAt,
  normalizeDate,
  scheduleDocumentId,
  scheduleKey,
};
const crypto = require("crypto");
