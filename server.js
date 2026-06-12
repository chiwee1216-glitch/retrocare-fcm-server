const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const {
  buildMedicineOverdueMessage,
  buildMedicineReminderMessage,
  buildMedicineCreatedMessage,
} = require("./notification_payload");
const { planTokenOwnership } = require("./fcm_token_ownership");
const {
  buildReminderKey,
  deriveCronSecret,
  isCronAuthorized,
} = require("./reminder_delivery");
const { processReminder } = require("./reminder_scheduler");
const {
  buildCycleDeliveryState,
  getReminderCycle,
  isRepeatReminderEligible,
  prepareCycleDelivery,
  shouldClaimCycle,
} = require("./repeat_reminder");
const {
  findNewTakenSlots,
  selectMedicineForTakenEvent,
} = require("./medicine_taken");

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
  const configuredSecrets = [
    String(process.env.CRON_SECRET || ""),
    deriveCronSecret(process.env.DEVICE_API_SECRET),
  ].filter(Boolean);
  const providedSecret = String(req.header("x-cron-secret") || "");

  if (configuredSecrets.length === 0) {
    return res.status(503).json({
      success: false,
      message: "Cron authentication is not configured",
    });
  }

  if (!configuredSecrets.some((secret) =>
    isCronAuthorized(providedSecret, secret)
  )) {
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
    const body = req.body || {};
    const slots = Array.isArray(body.status?.slots) ? body.status.slots : [];
    const reportResult = await db.runTransaction(async (transaction) => {
      const deviceDoc = await transaction.get(deviceRef);

      if (!deviceDoc.exists) {
        return { registered: false, newTakenSlots: [] };
      }

      const deviceData = deviceDoc.data() || {};
      const takenResult = findNewTakenSlots({
        previousActiveSlots: deviceData.activeTakenSlots || [],
        slots,
      });

      transaction.set(
        deviceRef,
        {
          status: body.status || {},
          activeTakenSlots: takenResult.activeSlots,
          localIp: body.localIp || "",
          firmwareVersion: body.firmwareVersion || "",
          lastCommandId: body.lastCommandId || "",
          lastSeen: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return {
        registered: true,
        patientId: deviceData.patientId || "",
        newTakenSlots: takenResult.newTakenSlots,
      };
    });

    if (!reportResult.registered) {
      return res.status(404).json({
        success: false,
        message: "Register this device ID in the app first",
      });
    }

    const completedMedicineIds = await persistTakenEvents({
      deviceId: req.deviceId,
      patientId: reportResult.patientId,
      slotNames: reportResult.newTakenSlots,
    });

    triggerReminderCheck();

    return res.json({
      success: true,
      takenEventCount: reportResult.newTakenSlots.length,
      completedMedicineIds,
    });
  } catch (error) {
    console.error("device report error:", error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

function buildScheduledDate(dateText, timeText) {
  const normalizedDate = String(dateText || "").replace(/\//g, "-");
  const normalizedTime = String(timeText || "").trim();
  const value = new Date(`${normalizedDate}T${normalizedTime}:00+08:00`);
  return Number.isNaN(value.getTime()) ? null : value;
}

async function persistTakenEvents({
  deviceId,
  patientId,
  slotNames,
}) {
  if (!patientId || slotNames.length === 0) return [];

  const medicinesSnapshot = await db
    .collection("medicines")
    .where("patientId", "==", patientId)
    .get();
  const medicines = medicinesSnapshot.docs.map((doc) => {
    const data = doc.data() || {};
    return {
      id: doc.id,
      ref: doc.ref,
      patientId: data.patientId || "",
      isDone: data.isDone === true,
      scheduledAt: buildScheduledDate(data.date, data.time),
    };
  });
  const completedMedicineIds = [];

  for (const slotName of slotNames) {
    const now = new Date();
    const selected = selectMedicineForTakenEvent({
      patientId,
      now,
      medicines,
    });
    const eventRef = db.collection("deviceTakenEvents").doc();
    const eventData = {
      deviceId,
      patientId,
      slotName,
      detectedAt: admin.firestore.FieldValue.serverTimestamp(),
      matchedMedicineId: selected?.id || "",
    };

    if (!selected) {
      await eventRef.set(eventData);
      continue;
    }

    const completed = await db.runTransaction(async (transaction) => {
      const medicineDoc = await transaction.get(selected.ref);
      if (!medicineDoc.exists || medicineDoc.data()?.isDone === true) {
        transaction.set(eventRef, {
          ...eventData,
          matchedMedicineId: "",
          matchError: "medicine_already_completed",
        });
        return false;
      }

      transaction.set(
        selected.ref,
        {
          isDone: true,
          completedByMedicineBox: true,
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      transaction.set(eventRef, eventData);
      return true;
    });

    if (completed) {
      completedMedicineIds.push(selected.id);
      selected.isDone = true;
    }
  }

  return completedMedicineIds;
}

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
  repeatCount = 0,
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

  const isOverdue = repeatCount > 0;
  const displayName = medicineName || "藥物";
  const title = isOverdue
    ? `未服藥提醒：${displayName}`
    : `服藥提醒：${displayName}`;
  const body = isOverdue
    ? `已超過 ${medicineTime || "預定"} 服藥時間，請儘快服藥。`
    : `第 ${doseIndex || 1} 次 / 共 ${totalDoses || 1} 次，時間 ${
        medicineTime || ""
      }，請記得服藥。`;
  const buildMessage = isOverdue
    ? buildMedicineOverdueMessage
    : buildMedicineReminderMessage;
  const message = buildMessage({
    tokens: allTokens,
    title,
    body,
    data: {
      patientId,
      medicineName: medicineName || "",
      medicineTime: medicineTime || "",
      reminderKey: reminderKey || "",
      repeatCount,
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
  medicineRef,
  cycle,
}) {
  const deliveryRef = db.collection("reminderDeliveries").doc(reminderKey);
  const nowMillis = Date.now();
  const leaseUntilMillis = nowMillis + 2 * 60 * 1000;

  return db.runTransaction(async (transaction) => {
    const [snapshot, medicineSnapshot] = await Promise.all([
      transaction.get(deliveryRef),
      transaction.get(medicineRef),
    ]);
    const delivery = snapshot.exists ? snapshot.data() || {} : {};
    const leaseUntil = delivery.reminderLeaseUntil?.toMillis?.() || 0;

    if (
      !medicineSnapshot.exists ||
      medicineSnapshot.data()?.isDone === true
    ) {
      return { claimed: false, delivery, reason: "medicine_completed" };
    }

    if (!shouldClaimCycle(delivery, cycle.cycleKey)) {
      return { claimed: false, delivery, reason: "cycle_completed" };
    }

    if (
      delivery.reminderState === "processing" &&
      leaseUntil > nowMillis
    ) {
      return { claimed: false, delivery, reason: "leased" };
    }

    const reminderAttemptCount =
      Number(delivery.reminderAttemptCount || 0) + 1;
    const isNewCycle = delivery.currentCycleKey !== cycle.cycleKey;
    const claimedDelivery = {
      ...delivery,
      reminderKey,
      medicineId,
      patientId,
      currentCycleKey: cycle.cycleKey,
      currentCycleCompleted: isNewCycle
        ? false
        : delivery.currentCycleCompleted === true,
      currentCyclePhoneSent: isNewCycle
        ? false
        : delivery.currentCyclePhoneSent === true,
      currentCycleMedicineBoxQueued: isNewCycle
        ? false
        : delivery.currentCycleMedicineBoxQueued === true,
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
        currentCycleKey: cycle.cycleKey,
        ...(isNewCycle
          ? {
              currentCycleCompleted: false,
              currentCyclePhoneSent: false,
              currentCycleMedicineBoxQueued: false,
            }
          : {}),
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

async function checkMedicineReminders() {
  const today = getTodayTaipeiDateText();
  const nowTime = getNowTaipeiTimeText();
  const now = new Date();
  const snapshot = await db
    .collection("medicines")
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
    const scheduledAt = buildScheduledDate(data.date, medicineTime);
    const cycle = getReminderCycle({
      scheduledAt,
      now,
      isDone: data.isDone === true,
    });
    const reminderKey = buildReminderKey(
      medicineId,
      data.date || "",
      medicineTime
    );

    if (
      !patientId ||
      !reminderKey ||
      !scheduledAt ||
      !isRepeatReminderEligible(scheduledAt) ||
      !cycle
    ) {
      summary.skippedCount++;
      continue;
    }

    try {
      const claim = await claimReminderDelivery({
        reminderKey,
        medicineId,
        patientId,
        medicineRef: doc.ref,
        cycle,
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
        delivery: prepareCycleDelivery(
          claim.delivery,
          cycle.cycleKey
        ),
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
            repeatCount: cycle.repeatCount,
          }),
        queueMedicineBox: () =>
          queueMedicineBoxCommand(patientId, "beep"),
      });
      const timestamp = admin.firestore.FieldValue.serverTimestamp();
      const cycleState = buildCycleDeliveryState({ cycle, result });
      const deliveryUpdate = {
        ...cycleState,
        scheduledMedicineAt:
          admin.firestore.Timestamp.fromDate(scheduledAt),
        nextRepeatAt:
          admin.firestore.Timestamp.fromDate(cycleState.nextRepeatAt),
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
        deliveryUpdate.currentCycleCompletedAt = timestamp;
        if (cycle.repeatCount === 0) {
          deliveryUpdate.initialReminderCompletedAt = timestamp;
        } else {
          deliveryUpdate.lastRepeatAt = timestamp;
        }
      }

      await claim.deliveryRef.set(deliveryUpdate, { merge: true });

      if (result.completed && cycle.repeatCount === 0) {
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
      } else if (!result.completed) {
        await doc.ref.set(
          {
            reminderError: result.errors.join("; "),
            reminderErrorAt: timestamp,
          },
          { merge: true }
        );
        summary.failedCount++;
      }
      if (result.completed) {
        summary.completedCount++;
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
