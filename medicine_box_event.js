const LEGACY_SLOT_INDEXES = new Map([
  ["早上格", 1],
  ["中午格", 2],
  ["晚上格", 3],
  ["睡前格", 4],
]);

function normalizeSlotIndex(value) {
  const directValue =
    typeof value === "object" && value !== null ? value.slotIndex : value;
  const direct = Number(directValue);

  if (Number.isInteger(direct) && direct >= 1 && direct <= 4) {
    return direct;
  }

  const label =
    typeof value === "object" && value !== null
      ? String(value.slot || "").trim()
      : String(value || "").trim();
  const numberedMatch = /^第\s*([1-4])\s*格$/.exec(label);

  if (numberedMatch) {
    return Number(numberedMatch[1]);
  }

  return LEGACY_SLOT_INDEXES.get(label) || null;
}

function shouldProcessEvent({ eventId, processedEventIds = [] }) {
  const normalizedEventId = String(eventId || "").trim();
  return (
    normalizedEventId.length > 0 && !processedEventIds.includes(normalizedEventId)
  );
}

function classifyPackageRemoved({ slotIndex, occurredAt, schedules = [] }) {
  const normalizedSlotIndex = normalizeSlotIndex(slotIndex);
  const occurredMillis = occurredAt?.getTime?.();
  const schedule = schedules.find(
    (item) =>
      normalizeSlotIndex(item.slotIndex) === normalizedSlotIndex &&
      !["completed", "exception_pending"].includes(item.status)
  );

  if (!schedule) {
    return {
      kind: "exception",
      reason: "unassigned_slot",
      scheduleId: "",
    };
  }

  const startMillis = schedule.normalWindowStart?.getTime?.();
  const endMillis = schedule.normalWindowEnd?.getTime?.();

  if (
    !Number.isFinite(occurredMillis) ||
    !Number.isFinite(startMillis) ||
    !Number.isFinite(endMillis) ||
    occurredMillis < startMillis ||
    occurredMillis > endMillis
  ) {
    return {
      kind: "exception",
      reason: "outside_normal_window",
      scheduleId: schedule.id,
    };
  }

  return {
    kind: "normal",
    reason: "",
    scheduleId: schedule.id,
  };
}

module.exports = {
  classifyPackageRemoved,
  normalizeSlotIndex,
  shouldProcessEvent,
};
