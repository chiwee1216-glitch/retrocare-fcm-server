const REPEAT_INTERVAL_MS = 5 * 60 * 1000;
const REPEAT_REMINDER_ROLLOUT_AT = new Date(
  "2026-06-11T16:00:00.000Z"
);

function isRepeatReminderEligible(scheduledAt) {
  const scheduledMillis = scheduledAt?.getTime?.();
  return (
    Number.isFinite(scheduledMillis) &&
    scheduledMillis >= REPEAT_REMINDER_ROLLOUT_AT.getTime()
  );
}

function getReminderCycle({ scheduledAt, now, isDone }) {
  if (isDone) return null;

  const scheduledMillis = scheduledAt?.getTime?.();
  const nowMillis = now?.getTime?.();
  if (
    !Number.isFinite(scheduledMillis) ||
    !Number.isFinite(nowMillis) ||
    nowMillis < scheduledMillis
  ) {
    return null;
  }

  const repeatCount = Math.floor(
    (nowMillis - scheduledMillis) / REPEAT_INTERVAL_MS
  );
  const dueAt = new Date(
    scheduledMillis + repeatCount * REPEAT_INTERVAL_MS
  );

  return {
    cycleKey: repeatCount === 0 ? "initial" : `repeat-${repeatCount}`,
    repeatCount,
    dueAt,
  };
}

function shouldClaimCycle(delivery = {}, cycleKey) {
  return !(
    delivery.currentCycleKey === cycleKey &&
    delivery.currentCycleCompleted === true
  );
}

function prepareCycleDelivery(delivery = {}, cycleKey) {
  const isCurrentCycle = delivery.currentCycleKey === cycleKey;

  return {
    phoneNotificationSent:
      isCurrentCycle && delivery.currentCyclePhoneSent === true,
    medicineBoxCommandQueued:
      isCurrentCycle && delivery.currentCycleMedicineBoxQueued === true,
    medicineBoxRequired: delivery.medicineBoxRequired !== false,
  };
}

function buildCycleDeliveryState({ cycle, result }) {
  return {
    reminderState: "pending",
    currentCycleKey: cycle.cycleKey,
    currentCycleCompleted: result.completed === true,
    currentCyclePhoneSent: result.phoneNotificationSent === true,
    currentCycleMedicineBoxQueued:
      result.medicineBoxCommandQueued === true,
    medicineBoxRequired: result.medicineBoxRequired !== false,
    repeatCount: cycle.repeatCount,
    nextRepeatAt: new Date(
      cycle.dueAt.getTime() + REPEAT_INTERVAL_MS
    ),
    reminderLastError: (result.errors || []).join("; "),
  };
}

module.exports = {
  REPEAT_INTERVAL_MS,
  buildCycleDeliveryState,
  getReminderCycle,
  isRepeatReminderEligible,
  prepareCycleDelivery,
  shouldClaimCycle,
};
