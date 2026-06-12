const {
  isDeliveryComplete,
  shouldAttemptMedicineBox,
  shouldAttemptPhone,
} = require("./reminder_delivery");

async function processReminder({
  delivery = {},
  medicineBoxRequired = true,
  sendPhone,
  queueMedicineBox,
}) {
  const result = {
    phoneNotificationSent: delivery.phoneNotificationSent === true,
    phoneNotificationResult: delivery.phoneNotificationResult || null,
    medicineBoxRequired:
      delivery.medicineBoxRequired === false ? false : medicineBoxRequired,
    medicineBoxCommandQueued:
      delivery.medicineBoxCommandQueued === true,
    medicineBoxResult: delivery.medicineBoxResult || null,
    completed: false,
    errors: [],
  };

  if (shouldAttemptPhone(result)) {
    try {
      result.phoneNotificationResult = await sendPhone();
      result.phoneNotificationSent =
        Number(result.phoneNotificationResult?.successCount || 0) > 0;

      if (!result.phoneNotificationSent) {
        result.errors.push("phone:no_successful_tokens");
      }
    } catch (error) {
      result.errors.push(`phone:${error.message}`);
    }
  }

  if (shouldAttemptMedicineBox(result)) {
    try {
      result.medicineBoxResult = await queueMedicineBox();

      if (result.medicineBoxResult?.queued === true) {
        result.medicineBoxCommandQueued = true;
      } else if (result.medicineBoxResult?.reason === "buzzer_disabled") {
        result.medicineBoxRequired = false;
      } else {
        result.errors.push(
          `medicine_box:${
            result.medicineBoxResult?.reason || "queue_failed"
          }`
        );
      }
    } catch (error) {
      result.errors.push(`medicine_box:${error.message}`);
    }
  }

  result.completed = isDeliveryComplete(result);
  return result;
}

module.exports = { processReminder };
