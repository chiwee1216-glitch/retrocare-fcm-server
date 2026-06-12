const crypto = require("crypto");

function buildReminderKey(medicineId, dateText, timeText) {
  const safeMedicineId = String(medicineId || "")
    .trim()
    .replace(/[\/\s]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  const safeSchedulePart = (value) =>
    String(value || "")
      .trim()
      .replace(/[\/:\s]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");

  return [
    safeMedicineId,
    safeSchedulePart(dateText),
    safeSchedulePart(timeText),
  ].join("_");
}

function deriveCronSecret(deviceSecret) {
  const source = String(deviceSecret || "");
  if (!source) return "";

  return crypto
    .createHash("sha256")
    .update(`retrocare-cron:${source}`, "utf8")
    .digest("hex");
}

function isCronAuthorized(providedSecret, configuredSecret) {
  const provided = Buffer.from(String(providedSecret || ""));
  const configured = Buffer.from(String(configuredSecret || ""));

  if (provided.length === 0 || provided.length !== configured.length) {
    return false;
  }

  return crypto.timingSafeEqual(provided, configured);
}

function requiredChannels({ buzzerEnabled } = {}) {
  return {
    phone: true,
    medicineBox: buzzerEnabled !== false,
  };
}

function shouldAttemptPhone(delivery = {}) {
  return delivery.phoneNotificationSent !== true;
}

function shouldAttemptMedicineBox(delivery = {}) {
  return (
    delivery.medicineBoxRequired !== false &&
    delivery.medicineBoxCommandQueued !== true
  );
}

function isDeliveryComplete(delivery = {}) {
  return (
    delivery.phoneNotificationSent === true &&
    (delivery.medicineBoxRequired === false ||
      delivery.medicineBoxCommandQueued === true)
  );
}

function isExpired({ nowMinutes, medicineMinutes }) {
  return (
    Number.isFinite(nowMinutes) &&
    Number.isFinite(medicineMinutes) &&
    nowMinutes - medicineMinutes > 10
  );
}

module.exports = {
  buildReminderKey,
  deriveCronSecret,
  isCronAuthorized,
  isDeliveryComplete,
  isExpired,
  requiredChannels,
  shouldAttemptMedicineBox,
  shouldAttemptPhone,
};
