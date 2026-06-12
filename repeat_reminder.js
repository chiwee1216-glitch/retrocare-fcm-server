const REPEAT_INTERVAL_MS = 5 * 60 * 1000;

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

module.exports = {
  REPEAT_INTERVAL_MS,
  getReminderCycle,
  shouldClaimCycle,
};
