const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const {
  buildMedicineReminderMessage,
  buildMedicineCreatedMessage,
} = require("./notification_payload");
const { planTokenOwnership } = require("./fcm_token_ownership");
const {
  buildReminderKey,
  isCronAuthorized,
  isExpired,
} = require("./reminder_delivery");
const { processReminder } = require("./reminder_scheduler");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const app = express();
let reminderCheckRunning = false;
let lastReminderCheckAt = 0;
const REMINDER_CHECK_MIN_INTERVAL_MS = 15000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("RetroCare FCM Server is running");
});

function authenticateMedicineBox(req, res, next) {
  const configuredSecret = process.env.DEVICE_API_SECRET;
  const deviceId = String(req.header("x-device-id") || "").trim();
  const deviceSecret = String(req.header("x-device-secret") || "");

  if (!configuredSecret) {
    return res.status(503).json({
      success: false,
      message: "DEVICE_API_SECRET is not configured",
    });
  }

  if (!deviceId || deviceSecret !== configuredSecret) {
    return res.status(401).json({
      success: false,
      message: "Invalid medicine box credentials",
    });
  }

  req.deviceId = deviceId;
  next();
}

function authenticateCron(req, res, next) {
  const configuredSecret = String(process.env.CRON_SECRET || "");

  if (!configuredSecret) {
    return res.status(503).json({
      success: false,
      message: "CRON_SECRET is not configured",
    });
  }

  if (
    !isCronAuthorized(
      String(req.header("x-cron-secret") || ""),
      configuredSecret
    )
  ) {
    return res.status(401).json({
      success: false,
      message: "Invalid cron credentials",
    });
  }

  next();
}

async function authenticateFirebaseUser(req, res, next) {
  try {
    const authorization = String(req.header("authorization") || "");
    const idToken = authorization.startsWith("Bearer ")
      ? authorization.slice(7).trim()
      : "";

    if (!idToken) {
      return res.status(401).json({
        success: false,
        message: "Missing Firebase ID token",
      });
    }

    req.firebaseUser = await admin.auth().verifyIdToken(idToken);
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid Firebase ID token",
    });
  }
}

app.post("/register-fcm-token", authenticateFirebaseUser, async (req, res) => {
  try {
    const activeUserId = req.firebaseUser.uid;
    const token = String(req.body?.token || "").trim();
    const previousToken = String(req.body?.previousToken || "").trim();

    if (!token) {
      return res.status(400).json({
        success: false,
        message: "FCM token required",
      });
    }

    const matchingSnapshot = await db
      .collection("users")
      .where("fcmTokens", "array-contains", token)
      .get();
    const previousSnapshot =
      previousToken && previousToken !== token
        ? await db
            .collection("users")
            .where("fcmTokens", "array-contains", previousToken)
            .get()
        : null;

    const plan = planTokenOwnership({
      activeUserId,
      token,
      previousToken,
      matchingUserIds: matchingSnapshot.docs.map((doc) => doc.id),
      previousTokenUserIds:
        previousSnapshot?.docs.map((doc) => doc.id) || [],
    });
    const removalBatch = db.batch();
    const removalsByUserId = new Map();

    for (const userId of plan.removeFromUserIds) {
      removalsByUserId.set(userId, new Set([token]));
    }

    for (const userId of plan.removePreviousFromUserIds) {
      const tokens = removalsByUserId.get(userId) || new Set();
      tokens.add(previousToken);
      removalsByUserId.set(userId, tokens);
    }

    for (const [userId, tokens] of removalsByUserId) {
      removalBatch.set(
        db.collection("users").doc(userId),
        {
          fcmTokens: admin.firestore.FieldValue.arrayRemove(...tokens),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    await removalBatch.commit();
    await db.collection("users").doc(plan.addToUserId).set(
      {
        fcmTokens: admin.firestore.FieldValue.arrayUnion(token),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return res.json({
      success: true,
      removedFromAccountCount: plan.removeFromUserIds.length,
      removedPreviousTokenCount: plan.removePreviousFromUserIds.length,
    });
  } catch (error) {
    console.error("register FCM token error:", error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.post("/device/report", authenticateMedicineBox, async (req, res) => {
  try {
    const deviceRef = db.collection("devices").doc(req.deviceId);
    const deviceDoc = await deviceRef.get();

    if (!deviceDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "Register this device ID in the app first",
      });
    }

    const body = req.body || {};

    await deviceRef.set(
      {
        status: body.status || {},
        localIp: body.localIp || "",
        firmwareVersion: body.firmwareVersion || "",
        lastCommandId: body.lastCommandId || "",
        lastSeen: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    triggerReminderCheck();

    return res.json({ success: true });
  } catch (error) {
    console.error("device report error:", error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.get("/device/config", authenticateMedicineBox, async (req, res) => {
  try {
    const deviceDoc = await db.collection("devices").doc(req.deviceId).get();

    if (!deviceDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "Register this device ID in the app first",
      });
    }

    const data = deviceDoc.data() || {};
    const command = data.deviceCommand || data.buzzerCommand || {};

    return res.json({
      success: true,
      buzzerEnabled: data.buzzerEnabled !== false,
      deviceCommandId: command.id || "",
      deviceAction: command.action || "",
    });
  } catch (error) {
    console.error("device config error:", error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

async function queueMedicineBoxCommand(patientId, action) {
  if (!patientId) {
    return { queued: false, reason: "missing_patient_id" };
  }

  const snapshot = await db
    .collection("devices")
    .where("patientId", "==", patientId)
    .limit(1)
    .get();

  if (snapshot.empty) {
    return { queued: false, reason: "device_not_registered" };
  }

  const deviceDoc = snapshot.docs[0];
  const deviceData = deviceDoc.data() || {};

  if (
    (action === "beep" || action === "help") &&
    deviceData.buzzerEnabled === false
  ) {
    return { queued: false, reason: "buzzer_disabled" };
  }

  await deviceDoc.ref.set(
    {
      deviceCommand: {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        action,
        issuedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return { queued: true, deviceId: deviceDoc.id };
}

async function sendMedicineNotification({
  patientId,
  caregiverId,
  medicineName,
  medicineTime,
  doseIndex,
  totalDoses,
  reminderKey,
}) {
  if (!patientId) {
    throw new Error("缺少 patientId");
  }

  const patientDoc = await db.collection("users").doc(patientId).get();

  if (!patientDoc.exists) {
    throw new Error("找不到病人資料");
  }

  const patientData = patientDoc.data();
  const patientTokens = patientData.fcmTokens || [];

  let caregiverTokens = [];

  if (caregiverId) {
    const caregiverDoc = await db.collection("users").doc(caregiverId).get();

    if (caregiverDoc.exists) {
      const caregiverData = caregiverDoc.data();
      caregiverTokens = caregiverData.fcmTokens || [];
    }
  }

  const allTokens = [...patientTokens, ...caregiverTokens];

  if (allTokens.length === 0) {
    return {
      success: false,
      message: "沒有可推播的 FCM Token",
      successCount: 0,
      failureCount: 0,
    };
  }

  const title = `服藥提醒：${medicineName || "藥物"}`;
  const body = `第 ${doseIndex || 1} 次 / 共 ${totalDoses || 1} 次，時間 ${
    medicineTime || ""
  }，請記得服藥`;

  const message = buildMedicineReminderMessage({
    tokens: allTokens,
    title,
    body,
    data: {
      patientId,
      medicineName: medicineName || "",
      medicineTime: medicineTime || "",
      reminderKey: reminderKey || "",
    },
  });
  const response = await admin.messaging().sendEachForMulticast(message);
  const invalidTokens = response.responses
    .map((item, index) => {
      const code = item.error?.code || "";
      return code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-registration-token"
        ? message.tokens[index]
        : "";
    })
    .filter(Boolean);

  if (invalidTokens.length > 0) {
    await removeInvalidFcmTokens(invalidTokens);
  }

  return {
    success: response.successCount > 0,
    successCount: response.successCount,
    failureCount: response.failureCount,
    invalidTokenCount: invalidTokens.length,
  };
}

async function removeInvalidFcmTokens(tokens) {
  const uniqueTokens = [...new Set(tokens.filter(Boolean))];

  for (const token of uniqueTokens) {
    const snapshot = await db
      .collection("users")
      .where("fcmTokens", "array-contains", token)
      .get();
    const batch = db.batch();

    for (const doc of snapshot.docs) {
      batch.set(
        doc.ref,
        {
          fcmTokens: admin.firestore.FieldValue.arrayRemove(token),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    await batch.commit();
  }
}

// 原本：立即推播
app.post("/send-medicine-notification", async (req, res) => {
  try {
    const {
      patientId,
      caregiverId,
      medicineName,
      medicineTime,
      doseIndex,
      totalDoses,
      reminderKey,
    } = req.body;

    const result = await sendMedicineNotification({
      patientId,
      caregiverId,
      medicineName,
      medicineTime,
      doseIndex,
      totalDoses,
      reminderKey,
    });

    return res.json(result);
  } catch (error) {
    console.error("推播失敗：", error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.post("/send-medicine-created-notification", async (req, res) => {
  try {
    const {
      patientId,
      medicineName,
      medicineDate,
      medicineTimes,
      medicineIds,
    } = req.body || {};

    if (!patientId) {
      return res.status(400).json({
        success: false,
        message: "patientId required",
      });
    }

    const patientDoc = await db.collection("users").doc(patientId).get();

    if (!patientDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "patient not found",
      });
    }

    const tokens = patientDoc.data().fcmTokens || [];
    const times = Array.isArray(medicineTimes) ? medicineTimes : [];
    const ids = Array.isArray(medicineIds) ? medicineIds : [];

    if (!tokens.length) {
      return res.json({
        success: false,
        message: "no patient fcm tokens",
        successCount: 0,
        failureCount: 0,
      });
    }

    const title = `已新增服藥提醒：${medicineName || "藥物"}`;
    const body = `${medicineDate || ""}，時間 ${times.join("、")}`;
    const result = await admin.messaging().sendEachForMulticast(
      buildMedicineCreatedMessage({
        tokens,
        title,
        body,
        data: {
        patientId,
        medicineName: medicineName || "",
        medicineDate: medicineDate || "",
        medicineTimes: JSON.stringify(times),
        medicineIds: JSON.stringify(ids),
      },
      })
    );

    return res.json({
      success: true,
      successCount: result.successCount,
      failureCount: result.failureCount,
    });
  } catch (error) {
    console.error("send medicine created notification error:", error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.post("/send-help-request-notification", async (req, res) => {
  try {
    const {
      requestId,
      patientId,
      patientName,
      caregiverId
    } = req.body;

    if (!caregiverId) {
      return res.status(400).json({
        error: "caregiverId required"
      });
    }

    const caregiverDoc = await db
      .collection("users")
      .doc(caregiverId)
      .get();

    if (!caregiverDoc.exists) {
      return res.status(404).json({
        error: "caregiver not found"
      });
    }

    const caregiverData = caregiverDoc.data();
    const tokens = caregiverData.fcmTokens || [];

    if (!tokens.length) {
      return res.status(404).json({
        error: "no caregiver fcm tokens"
      });
    }

    const message = {
      tokens,
      data: {
        type: "help_request",
        title: "病患求助通知",
        body: `${patientName || "病患"} 需要協助，請立即確認狀況`,
        requestId: requestId || "",
        patientId: patientId || "",
        patientName: patientName || ""
      },
      android: {
        priority: "high"
      }
    };

    const result = await admin
      .messaging()
      .sendEachForMulticast(message);

    return res.json({
      ok: true,
      successCount: result.successCount,
      failureCount: result.failureCount
    });
  } catch (error) {
    console.error("send help request notification error:", error);

    return res.status(500).json({
      error: error.message
    });
  }
});

// 台灣日期 yyyy/MM/dd
function getTodayTaipeiDateText() {
  const now = new Date();

  const taipeiText = now.toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  return taipeiText.replace(/\//g, "/");
}

// 台灣時間 HH:mm
function getNowTaipeiTimeText() {
  const now = new Date();

  return now.toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function timeTextToMinutes(value) {
  const parts = String(value || "").split(":");
  if (parts.length !== 2) return null;

  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;

  return hour * 60 + minute;
}

async function claimReminderDelivery({
  reminderKey,
  medicineId,
  patientId,
}) {
  const deliveryRef = db.collection("reminderDeliveries").doc(reminderKey);
  const nowMillis = Date.now();
  const leaseUntilMillis = nowMillis + 2 * 60 * 1000;

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(deliveryRef);
    const delivery = snapshot.exists ? snapshot.data() || {} : {};
    const leaseUntil = delivery.reminderLeaseUntil?.toMillis?.() || 0;

    if (
      delivery.reminderState === "completed" ||
      delivery.reminderState === "expired"
    ) {
      return { claimed: false, delivery, reason: delivery.reminderState };
    }

    if (
      delivery.reminderState === "processing" &&
      leaseUntil > nowMillis
    ) {
      return { claimed: false, delivery, reason: "leased" };
    }

    const reminderAttemptCount =
      Number(delivery.reminderAttemptCount || 0) + 1;
    const claimedDelivery = {
      ...delivery,
      reminderKey,
      medicineId,
      patientId,
      reminderState: "processing",
      reminderAttemptCount,
      reminderLeaseUntil:
        admin.firestore.Timestamp.fromMillis(leaseUntilMillis),
    };

    transaction.set(
      deliveryRef,
      {
        reminderKey,
        medicineId,
        patientId,
        reminderState: "processing",
        reminderAttemptCount,
        reminderLeaseUntil:
          admin.firestore.Timestamp.fromMillis(leaseUntilMillis),
        reminderLastAttemptAt:
          admin.firestore.FieldValue.serverTimestamp(),
        createdAt:
          delivery.createdAt ||
          admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return { claimed: true, delivery: claimedDelivery, deliveryRef };
  });
}

async function expireReminder({ doc, reminderKey, patientId }) {
  const deliveryRef = db.collection("reminderDeliveries").doc(reminderKey);
  const timestamp = admin.firestore.FieldValue.serverTimestamp();

  await Promise.all([
    deliveryRef.set(
      {
        reminderKey,
        medicineId: doc.id,
        patientId,
        reminderState: "expired",
        reminderLeaseUntil: null,
        reminderExpiredAt: timestamp,
        updatedAt: timestamp,
      },
      { merge: true }
    ),
    doc.ref.set(
      {
        reminderExpired: true,
        reminderExpiredAt: timestamp,
      },
      { merge: true }
    ),
  ]);
}

async function checkMedicineReminders() {
  const today = getTodayTaipeiDateText();
  const nowTime = getNowTaipeiTimeText();
  const nowMinutes = timeTextToMinutes(nowTime);
  const snapshot = await db
    .collection("medicines")
    .where("date", "==", today)
    .where("isDone", "==", false)
    .get();
  const summary = {
    success: true,
    today,
    nowTime,
    checkedCount: 0,
    claimedCount: 0,
    completedCount: 0,
    retryCount: 0,
    expiredCount: 0,
    skippedCount: 0,
    failedCount: 0,
  };

  for (const doc of snapshot.docs) {
    summary.checkedCount++;
    const data = doc.data() || {};
    const medicineId = doc.id;
    const patientId = data.patientId || "";
    const caregiverId = data.caregiverId || "";
    const medicineName = data.name || "藥物";
    const medicineTime = data.time || "";
    const doseIndex = data.doseIndex || 1;
    const totalDoses = parseInt(data.times || "1", 10) || 1;
    const medicineMinutes = timeTextToMinutes(medicineTime);
    const reminderKey = buildReminderKey(
      medicineId,
      today,
      medicineTime
    );

    if (
      !patientId ||
      !reminderKey ||
      medicineMinutes === null ||
      nowMinutes === null ||
      medicineMinutes > nowMinutes ||
      data.reminderSent === true
    ) {
      summary.skippedCount++;
      continue;
    }

    if (isExpired({ nowMinutes, medicineMinutes })) {
      await expireReminder({ doc, reminderKey, patientId });
      summary.expiredCount++;
      continue;
    }

    try {
      const claim = await claimReminderDelivery({
        reminderKey,
        medicineId,
        patientId,
      });

      if (!claim.claimed) {
        summary.skippedCount++;
        continue;
      }

      summary.claimedCount++;
      if (Number(claim.delivery.reminderAttemptCount || 0) > 1) {
        summary.retryCount++;
      }

      const result = await processReminder({
        delivery: claim.delivery,
        medicineBoxRequired:
          claim.delivery.medicineBoxRequired !== false,
        sendPhone: () =>
          sendMedicineNotification({
            patientId,
            caregiverId,
            medicineName,
            medicineTime,
            doseIndex,
            totalDoses,
            reminderKey,
          }),
        queueMedicineBox: () =>
          queueMedicineBoxCommand(patientId, "beep"),
      });
      const timestamp = admin.firestore.FieldValue.serverTimestamp();
      const deliveryUpdate = {
        reminderState: result.completed ? "completed" : "pending",
        reminderLeaseUntil: null,
        phoneNotificationSent: result.phoneNotificationSent,
        phoneNotificationResult: result.phoneNotificationResult,
        medicineBoxRequired: result.medicineBoxRequired,
        medicineBoxCommandQueued: result.medicineBoxCommandQueued,
        medicineBoxResult: result.medicineBoxResult,
        reminderLastError: result.errors.join("; "),
        updatedAt: timestamp,
      };

      if (result.phoneNotificationSent) {
        deliveryUpdate.phoneNotificationSentAt = timestamp;
      }
      if (result.medicineBoxCommandQueued) {
        deliveryUpdate.medicineBoxCommandQueuedAt = timestamp;
      }
      if (result.completed) {
        deliveryUpdate.reminderCompletedAt = timestamp;
      }

      await claim.deliveryRef.set(deliveryUpdate, { merge: true });

      if (result.completed) {
        await doc.ref.set(
          {
            reminderSent: true,
            reminderSentAt: timestamp,
            reminderResult: result.phoneNotificationResult,
            medicineBoxReminderResult: result.medicineBoxResult,
            reminderError: "",
          },
          { merge: true }
        );
        summary.completedCount++;
      } else {
        await doc.ref.set(
          {
            reminderError: result.errors.join("; "),
            reminderErrorAt: timestamp,
          },
          { merge: true }
        );
        summary.failedCount++;
      }
    } catch (error) {
      summary.failedCount++;
      console.error(
        `Medicine reminder failed reminderKey=${reminderKey}`,
        error
      );
    }
  }

  return summary;
}

app.post(
  "/internal/check-medicine-reminders",
  authenticateCron,
  async (req, res) => {
    try {
      return res.json(await checkMedicineReminders());
    } catch (error) {
      console.error("Medicine reminder check endpoint failed:", error);
      return res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  }
);

function triggerReminderCheck({ force = false } = {}) {
  const now = Date.now();

  if (reminderCheckRunning) {
    return false;
  }

  if (!force && now - lastReminderCheckAt < REMINDER_CHECK_MIN_INTERVAL_MS) {
    return false;
  }

  lastReminderCheckAt = now;
  reminderCheckRunning = true;

  Promise.resolve()
    .then(() => checkMedicineReminders())
    .then((result) => {
      if (result.completedCount > 0 || result.failedCount > 0) {
        console.log("Medicine reminder check result:", result);
      }
    })
    .catch((error) => {
      console.error("Medicine reminder check failed:", error);
    })
    .finally(() => {
      reminderCheckRunning = false;
    });

  return true;
}

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`RetroCare FCM Server running on port ${PORT}`);
  triggerReminderCheck({ force: true });
});

setInterval(() => {
  triggerReminderCheck();
}, 30000);
