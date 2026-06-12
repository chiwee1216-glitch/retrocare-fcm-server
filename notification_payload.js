const MEDICINE_CHANNEL_ID = "medicine_fcm_channel_v5";

function stringifyData(data) {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, String(value ?? "")])
  );
}

function buildMedicineMessage({ type, tokens, title, body, data }) {
  return {
    tokens: [...new Set(tokens.filter(Boolean))],
    notification: {
      title,
      body,
    },
    data: {
      type,
      title,
      body,
      ...stringifyData(data),
    },
    android: {
      priority: "high",
      notification: {
        channelId: MEDICINE_CHANNEL_ID,
        sound: "default",
      },
    },
  };
}

function buildMedicineReminderMessage({ tokens, title, body, data }) {
  return buildMedicineMessage({
    type: "medicine_reminder",
    tokens,
    title,
    body,
    data,
  });
}

function buildMedicineCreatedMessage({ tokens, title, body, data }) {
  return buildMedicineMessage({
    type: "medicine_created",
    tokens,
    title,
    body,
    data,
  });
}

module.exports = {
  buildMedicineReminderMessage,
  buildMedicineCreatedMessage,
};
