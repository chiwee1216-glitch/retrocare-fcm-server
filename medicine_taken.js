function findNewTakenSlots({ previousActiveSlots = [], slots = [] }) {
  const previous = new Set(previousActiveSlots);
  const activeSlots = slots
    .filter((slot) => slot?.taken === true)
    .map((slot) => String(slot.slot || "").trim())
    .filter(Boolean);

  return {
    activeSlots,
    newTakenSlots: activeSlots.filter((slot) => !previous.has(slot)),
  };
}

function selectMedicineForTakenEvent({ patientId, now, medicines = [] }) {
  const nowMillis = now?.getTime?.();
  if (!patientId || !Number.isFinite(nowMillis)) return null;

  const candidates = medicines
    .filter((medicine) => {
      const scheduledMillis = medicine.scheduledAt?.getTime?.();
      return (
        medicine.patientId === patientId &&
        medicine.isDone !== true &&
        Number.isFinite(scheduledMillis) &&
        scheduledMillis <= nowMillis
      );
    })
    .map((medicine) => ({
      ...medicine,
      distance: nowMillis - medicine.scheduledAt.getTime(),
    }))
    .sort((a, b) => a.distance - b.distance);

  if (candidates.length === 0) return null;
  if (
    candidates.length > 1 &&
    candidates[0].distance === candidates[1].distance
  ) {
    return null;
  }

  return candidates[0];
}

module.exports = {
  findNewTakenSlots,
  selectMedicineForTakenEvent,
};
