const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");
const {
  buildMedicineOverdueMessage,
  buildMedicineReminderMessage,
  buildMedicineCreatedMessage,
  buildMedicineExceptionMessage,
  buildMedicineRefillMessage,
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
  buildScheduleAssignments,
  normalizeDate,
} = require("./medicine_schedule");
const {
  classifyPackageRemoved,
  normalizeSlotIndex,
} = require("./medicine_box_event");
const {
  shouldPersistDeviceReport,
} = require("./device_report_throttle");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const app = express();
let reminderCheckRunning = false;
let lastReminderCheckAt = 0;
const REMINDER_CHECK_MIN_INTERVAL_MS = 15000;
const deviceReportPersistedAt = new Map();
const DEVICE_CONFIG_CACHE_TTL_MS = 5 * 1000;
const deviceConfigCache = new Map();

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

async function getCachedDeviceConfig(deviceId) {
  const cached = deviceConfigCache.get(deviceId);
  const now = Date.now();
  if (cached && now - cached.cachedAt < DEVICE_CONFIG_CACHE_TTL_MS) {
    return cached.deviceDoc;
  }

  const deviceDoc = await db.collection("devices").doc(deviceId).get();
  if (deviceDoc.exists) {
    deviceConfigCache.set(deviceId, {
      cachedAt: now,
      deviceDoc,
    });
  } else {
    deviceConfigCache.delete(deviceId);
  }
  return deviceDoc;
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
    const reportedEvents = Array.isArray(body.events) ? body.events : [];
    const reportedCommandId = String(body.lastCommandId || "").trim();
    const nowMillis = Date.now();
    const shouldPersist = shouldPersistDeviceReport({
      lastPersistedAt: deviceReportPersistedAt.get(req.deviceId) || 0,
      now: nowMillis,
      eventCount: reportedEvents.length,
      hasCommandAck: reportedCommandId.length > 0,
    });

    if (!shouldPersist) {
      return res.json({
        success: true,
        throttled: true,
        processedEventCount: 0,
        completedMedicineIds: [],
        exceptionIds: [],
      });
    }

    const reportResult = await db.runTransaction(async (transaction) => {
      const deviceDoc = await transaction.get(deviceRef);

      if (!deviceDoc.exists) {
        return { registered: false, legacyEvents: [] };
      }

      const deviceData = deviceDoc.data() || {};
      const previousActiveSlots = new Set(
        (deviceData.activeTakenSlots || [])
          .map(normalizeSlotIndex)
          .filter(Boolean)
      );
      const activeTakenSlots = slots
        .filter((slot) => slot?.taken === true)
        .map(normalizeSlotIndex)
        .filter(Boolean);
      const legacyEvents =
        reportedEvents.length > 0
          ? []
          : activeTakenSlots
              .filter((slotIndex) => !previousActiveSlots.has(slotIndex))
              .map((slotIndex) => ({
                eventId: `${req.deviceId}-legacy-${slotIndex}-${Date.now()}`,
                type: "package_removed",
                slotIndex,
                occurredAt: new Date().toISOString(),
              }));
      const normalizedSlots = slots.map((slot) => {
        const slotIndex = normalizeSlotIndex(slot);
        return {
          ...slot,
          ...(slotIndex
            ? { slotIndex, slot: `第 ${slotIndex} 格` }
            : {}),
        };
      });

      transaction.set(
        deviceRef,
        {
          status: {
            ...(body.status || {}),
            slots: normalizedSlots,
          },
          activeTakenSlots,
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
        legacyEvents,
      };
    });

    if (!reportResult.registered) {
      return res.status(404).json({
        success: false,
        message: "Register this device ID in the app first",
      });
    }
    deviceReportPersistedAt.set(req.deviceId, nowMillis);

    const eventResult = await persistMedicineBoxEvents({
      deviceId: req.deviceId,
      patientId: reportResult.patientId,
      events:
        reportedEvents.length > 0
          ? reportedEvents
          : reportResult.legacyEvents,
    });

    triggerReminderCheck();

    return res.json({
      success: true,
      processedEventCount: eventResult.processedEventCount,
      completedMedicineIds: eventResult.completedMedicineIds,
      exceptionIds: eventResult.exceptionIds,
    });
  } catch (error) {
    console.error("device report error:", error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

function taipeiDateText(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(date)
    .replace(/-/g, "/");
}

function stableDocumentId(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function parseEventDate(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? new Date() : date;
  }

  const date = new Date(String(value || ""));
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

async function ensureDailySchedules(patientId, dateText) {
  const medicinesSnapshot = await db
    .collection("medicines")
    .where("patientId", "==", patientId)
    .get();
  const medicines = medicinesSnapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((medicine) => normalizeDate(medicine.date) === dateText);
  const { schedules: builtSchedules } = buildScheduleAssignments(medicines);
  const scheduleEntries = await Promise.all(
    builtSchedules.map(async (schedule) => {
      const id = schedule.id;
      const ref = db.collection("medicineSchedules").doc(id);
      const existing = await ref.get();
      const currentData = existing.data() || {};

      return {
        ...schedule,
        id,
        ref,
        status: currentData.status || schedule.status,
        completedAt: currentData.completedAt || null,
      };
    })
  );
  const batch = db.batch();

  for (const schedule of scheduleEntries) {
    batch.set(
      schedule.ref,
      {
        patientId: schedule.patientId,
        caregiverId: schedule.caregiverId,
        date: schedule.date,
        time: schedule.time,
        slotIndex: schedule.slotIndex,
        medicineIds: schedule.medicineIds,
        medicineItems: schedule.medicineItems,
        scheduledAt: admin.firestore.Timestamp.fromDate(schedule.scheduledAt),
        normalWindowStart: admin.firestore.Timestamp.fromDate(
          schedule.normalWindowStart
        ),
        normalWindowEnd: admin.firestore.Timestamp.fromDate(
          schedule.normalWindowEnd
        ),
        status: schedule.status,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  if (scheduleEntries.length > 0) {
    await batch.commit();
  }

  return scheduleEntries;
}

async function canAccessPatient(userId, patientId) {
  if (!userId || !patientId) return false;
  if (userId === patientId) return true;

  const [userDoc, patientDoc] = await Promise.all([
    db.collection("users").doc(userId).get(),
    db.collection("users").doc(patientId).get(),
  ]);
  const userData = userDoc.data() || {};
  const patientData = patientDoc.data() || {};
  const linkedPatients = Array.isArray(userData.linkedPatients)
    ? userData.linkedPatients
    : [];

  return (
    String(userData.linkedPatientId || "") === patientId ||
    linkedPatients.some(
      (item) => String(item?.patientId || item || "") === patientId
    ) ||
    String(patientData.linkedCaregiverId || "") === userId
  );
}

app.post("/device/command", authenticateFirebaseUser, async (req, res) => {
  try {
    const patientId = String(req.body?.patientId || "").trim();
    const action = String(req.body?.action || "").trim();
    const allowedActions = new Set(["beep", "help", "check_led"]);

    if (!patientId) {
      return res.status(400).json({
        success: false,
        message: "patientId required",
      });
    }

    if (!allowedActions.has(action)) {
      return res.status(400).json({
        success: false,
        message: "invalid device action",
      });
    }

    if (!(await canAccessPatient(req.firebaseUser.uid, patientId))) {
      return res.status(403).json({
        success: false,
        message: "Not authorized for this patient",
      });
    }

    const result = await queueMedicineBoxCommand(patientId, action);
    const success = result.queued || result.reason === "buzzer_disabled";

    return res.status(success ? 200 : 404).json({
      success,
      ...result,
    });
  } catch (error) {
    console.error("device command error:", error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.post("/device/settings", authenticateFirebaseUser, async (req, res) => {
  try {
    const patientId = String(req.body?.patientId || "").trim();
    const patientName = String(req.body?.patientName || "").trim();
    const deviceId = String(req.body?.deviceId || "").trim().toUpperCase();
    const previousDeviceId = String(req.body?.previousDeviceId || "")
      .trim()
      .toUpperCase();
    const buzzerEnabled = req.body?.buzzerEnabled !== false;

    if (!patientId || !deviceId) {
      return res.status(400).json({
        success: false,
        message: "patientId and deviceId required",
      });
    }

    if (!/^[A-Z0-9_-]{3,40}$/.test(deviceId)) {
      return res.status(400).json({
        success: false,
        message: "invalid deviceId",
      });
    }

    if (!(await canAccessPatient(req.firebaseUser.uid, patientId))) {
      return res.status(403).json({
        success: false,
        message: "Not authorized for this patient",
      });
    }

    const batch = db.batch();
    if (previousDeviceId && previousDeviceId !== deviceId) {
      const previousRef = db.collection("devices").doc(previousDeviceId);
      const previousDoc = await previousRef.get();
      if (previousDoc.exists) {
        const previousData = previousDoc.data() || {};
        if (String(previousData.patientId || "") === patientId) {
          batch.delete(previousRef);
          deviceConfigCache.delete(previousDeviceId);
        }
      }
    }

    batch.set(
      db.collection("devices").doc(deviceId),
      {
        patientId,
        patientName,
        buzzerEnabled,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await batch.commit();
    deviceConfigCache.delete(deviceId);

    return res.json({
      success: true,
      deviceId,
      buzzerEnabled,
    });
  } catch (error) {
    console.error("device settings error:", error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.post(
  "/medicine-schedules/sync",
  authenticateFirebaseUser,
  async (req, res) => {
    try {
      const patientId = String(req.body?.patientId || "").trim();
      const dateText = normalizeDate(req.body?.date);

      if (!patientId || !dateText) {
        return res.status(400).json({
          success: false,
          message: "缺少病人或日期資料",
        });
      }

      if (!(await canAccessPatient(req.firebaseUser.uid, patientId))) {
        return res.status(403).json({
          success: false,
          message: "沒有權限管理此病人的服藥時程",
        });
      }

      let schedules;
      try {
        schedules = await ensureDailySchedules(patientId, dateText);
      } catch (error) {
        if (String(error.message).includes("最多支援四個服藥時段")) {
          return res.status(409).json({
            success: false,
            message: error.message,
          });
        }
        throw error;
      }

      const batch = db.batch();
      const validScheduleIds = new Set(
        schedules.map((schedule) => schedule.id)
      );
      const existingSchedules = await db
        .collection("medicineSchedules")
        .where("patientId", "==", patientId)
        .get();
      for (const doc of existingSchedules.docs) {
        const data = doc.data() || {};
        if (
          normalizeDate(data.date) === dateText &&
          !validScheduleIds.has(doc.id) &&
          !["completed", "exception_pending"].includes(data.status)
        ) {
          batch.delete(doc.ref);
        }
      }
      for (const schedule of schedules) {
        for (const medicineId of schedule.medicineIds) {
          batch.set(
            db.collection("medicines").doc(medicineId),
            {
              scheduleId: schedule.id,
              slotIndex: schedule.slotIndex,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }
      }
      await batch.commit();

      return res.json({
        success: true,
        schedules: schedules.map((schedule) => ({
          id: schedule.id,
          date: schedule.date,
          time: schedule.time,
          slotIndex: schedule.slotIndex,
          status: schedule.status,
          medicineIds: schedule.medicineIds,
          medicineItems: schedule.medicineItems,
        })),
      });
    } catch (error) {
      console.error("schedule sync error:", error);
      return res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  }
);

app.post(
  "/medicine-exceptions/:id/resolve",
  authenticateFirebaseUser,
  async (req, res) => {
    try {
      const exceptionRef = db
        .collection("medicineExceptions")
        .doc(String(req.params.id || ""));
      const exceptionDoc = await exceptionRef.get();

      if (!exceptionDoc.exists) {
        return res.status(404).json({
          success: false,
          message: "找不到這筆異常取藥紀錄",
        });
      }

      const exception = exceptionDoc.data() || {};
      const patientId = String(exception.patientId || "");
      const resolution = String(req.body?.resolution || "");

      if (
        req.firebaseUser.uid === patientId ||
        !(await canAccessPatient(req.firebaseUser.uid, patientId))
      ) {
        return res.status(403).json({
          success: false,
          message: "只有綁定的看護可以確認異常取藥",
        });
      }

      if (!["confirmed_taken", "confirmed_not_taken"].includes(resolution)) {
        return res.status(400).json({
          success: false,
          message: "異常確認結果不正確",
        });
      }

      const scheduleRef = exception.scheduleId
        ? db.collection("medicineSchedules").doc(exception.scheduleId)
        : null;
      await db.runTransaction(async (transaction) => {
        const scheduleDoc = scheduleRef
          ? await transaction.get(scheduleRef)
          : null;
        const schedule = scheduleDoc?.data() || {};

        transaction.set(
          exceptionRef,
          {
            status: "resolved",
            resolution,
            resolvedBy: req.firebaseUser.uid,
            resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        if (!scheduleRef) return;

        if (resolution === "confirmed_taken") {
          transaction.set(
            scheduleRef,
            {
              status: "completed",
              completedAt: admin.firestore.FieldValue.serverTimestamp(),
              completedByCaregiverConfirmation: true,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          for (const medicineId of schedule.medicineIds || []) {
            transaction.set(
              db.collection("medicines").doc(medicineId),
              {
                isDone: true,
                completedAt: admin.firestore.FieldValue.serverTimestamp(),
                completedByCaregiverConfirmation: true,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
          }
        } else {
          transaction.set(
            scheduleRef,
            {
              status: "reminding",
              exceptionId: "",
              nextReminderAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }
      });

      triggerReminderCheck();
      return res.json({ success: true, resolution });
    } catch (error) {
      console.error("resolve medicine exception error:", error);
      return res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  }
);

async function persistMedicineBoxEvents({ deviceId, patientId, events }) {
  if (!patientId || !Array.isArray(events) || events.length === 0) {
    return {
      processedEventCount: 0,
      completedMedicineIds: [],
      exceptionIds: [],
    };
  }

  const completedMedicineIds = [];
  const exceptionIds = [];
  let processedEventCount = 0;
  const schedulesByDate = new Map();

  for (const rawEvent of events) {
    const eventId = String(rawEvent?.eventId || "").trim();
    const type = String(rawEvent?.type || rawEvent?.eventType || "").trim();

    if (!eventId || !type) continue;

    const occurredAt = parseEventDate(rawEvent.occurredAt);
    const dateText = taipeiDateText(occurredAt);
    const eventDocumentId = stableDocumentId(`${deviceId}:${eventId}`);
    const eventRef = db.collection("medicineBoxEvents").doc(eventDocumentId);
    const existingEvent = await eventRef.get();

    if (existingEvent.exists) continue;

    if (!schedulesByDate.has(dateText)) {
      schedulesByDate.set(
        dateText,
        await ensureDailySchedules(patientId, dateText)
      );
    }

    const schedules = schedulesByDate.get(dateText);
    const slotIndex = normalizeSlotIndex(rawEvent.slotIndex ?? rawEvent.slot);
    const baseEventData = {
      eventId,
      type,
      deviceId,
      patientId,
      slotIndex,
      occurredAt: admin.firestore.Timestamp.fromDate(occurredAt),
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (type !== "package_removed") {
      await eventRef.create(baseEventData);
      processedEventCount += 1;
      continue;
    }

    const classification = classifyPackageRemoved({
      slotIndex,
      occurredAt,
      schedules,
    });
    const schedule = schedules.find(
      (item) => item.id === classification.scheduleId
    );

    if (classification.kind === "normal" && schedule) {
      const completed = await db.runTransaction(async (transaction) => {
        const [freshEvent, freshSchedule] = await Promise.all([
          transaction.get(eventRef),
          transaction.get(schedule.ref),
        ]);

        if (freshEvent.exists) return false;
        const currentStatus = freshSchedule.data()?.status || "scheduled";

        if (currentStatus === "completed") {
          transaction.create(eventRef, {
            ...baseEventData,
            result: "ignored_already_completed",
            scheduleId: schedule.id,
          });
          return false;
        }

        transaction.set(
          schedule.ref,
          {
            status: "completed",
            actualTakenAt: admin.firestore.Timestamp.fromDate(occurredAt),
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
            completedByMedicineBox: true,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        for (const medicineId of schedule.medicineIds) {
          transaction.set(
            db.collection("medicines").doc(medicineId),
            {
              isDone: true,
              slotIndex: schedule.slotIndex,
              scheduleId: schedule.id,
              completedByMedicineBox: true,
              completedAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }
        transaction.create(eventRef, {
          ...baseEventData,
          result: "completed",
          scheduleId: schedule.id,
          medicineIds: schedule.medicineIds,
        });
        return true;
      });

      if (completed) {
        schedule.status = "completed";
        completedMedicineIds.push(...schedule.medicineIds);
      }
    } else {
      const exceptionRef = db
        .collection("medicineExceptions")
        .doc(eventDocumentId);
      await db.runTransaction(async (transaction) => {
        const freshEvent = await transaction.get(eventRef);
        if (freshEvent.exists) return;

        transaction.create(eventRef, {
          ...baseEventData,
          result: "exception_pending",
          reason: classification.reason,
          scheduleId: classification.scheduleId,
        });
        transaction.set(
          exceptionRef,
          {
            deviceId,
            patientId,
            slotIndex,
            scheduleId: classification.scheduleId,
            reason: classification.reason,
            status: "pending",
            occurredAt: admin.firestore.Timestamp.fromDate(occurredAt),
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        if (schedule) {
          transaction.set(
            schedule.ref,
            {
              status: "exception_pending",
              exceptionId: exceptionRef.id,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }
      });

      if (schedule) schedule.status = "exception_pending";
      exceptionIds.push(exceptionRef.id);
      await sendMedicineEventNotification({
        userIds: [patientId, schedule?.caregiverId],
        buildMessage: buildMedicineExceptionMessage,
        title: "異常取藥，需要看護確認",
        body: slotIndex
          ? `第 ${slotIndex} 格在非預定時間取藥，已暫停一般服藥提醒。`
          : "偵測到未分配藥格的取藥事件，請看護確認。",
        data: {
          eventKey: `medicine-exception:${exceptionRef.id}`,
          exceptionId: exceptionRef.id,
          patientId,
          scheduleId: classification.scheduleId,
          slotIndex: slotIndex || "",
        },
      });
    }

    processedEventCount += 1;
  }

  return {
    processedEventCount,
    completedMedicineIds: [...new Set(completedMedicineIds)],
    exceptionIds: [...new Set(exceptionIds)],
  };
}

function buildScheduledDate(dateText, timeText) {
  const normalizedDate = String(dateText || "").replace(/\//g, "-");
  const normalizedTime = String(timeText || "").trim();
  const value = new Date(`${normalizedDate}T${normalizedTime}:00+08:00`);
  return Number.isNaN(value.getTime()) ? null : value;
}

app.get("/device/config", authenticateMedicineBox, async (req, res) => {
  try {
    const deviceDoc = await getCachedDeviceConfig(req.deviceId);

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
  deviceConfigCache.delete(deviceDoc.id);

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
  const cycleKey = repeatCount === 0
    ? "initial"
    : `repeat-${repeatCount}`;
  const message = buildMessage({
    tokens: allTokens,
    title,
    body,
    data: {
      patientId,
      medicineName: medicineName || "",
      medicineTime: medicineTime || "",
      reminderKey: reminderKey || "",
      reminderCycleKey: `${reminderKey || ""}:${cycleKey}`,
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

async function sendMedicineEventNotification({
  userIds,
  buildMessage,
  title,
  body,
  data,
}) {
  const uniqueUserIds = [...new Set(userIds.filter(Boolean))];
  const userDocs = await Promise.all(
    uniqueUserIds.map((userId) => db.collection("users").doc(userId).get())
  );
  const tokens = userDocs.flatMap((doc) => doc.data()?.fcmTokens || []);

  if (tokens.length === 0) {
    return { success: false, successCount: 0, failureCount: 0 };
  }

  const message = buildMessage({ tokens, title, body, data });
  const response = await admin.messaging().sendEachForMulticast(message);
  return {
    success: response.successCount > 0,
    successCount: response.successCount,
    failureCount: response.failureCount,
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

    const patientData = patientDoc.data() || {};
    const caregiverId = String(patientData.linkedCaregiverId || "");
    const caregiverDoc = caregiverId
      ? await db.collection("users").doc(caregiverId).get()
      : null;
    const tokens = [
      ...(patientData.fcmTokens || []),
      ...(caregiverDoc?.data()?.fcmTokens || []),
    ];
    const times = Array.isArray(medicineTimes) ? medicineTimes : [];
    const ids = Array.isArray(medicineIds) ? medicineIds : [];
    const creationBatchId = String(
      req.body?.creationBatchId ||
        `${patientId}:${medicineDate}:${Date.now()}`
    );

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
          eventKey: `medicine-created:${creationBatchId}`,
          creationBatchId,
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

    const sourceData = medicineSnapshot.data() || {};
    if (
      !medicineSnapshot.exists ||
      sourceData.isDone === true ||
      ["completed", "exception_pending"].includes(sourceData.status)
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
  await checkDailyMedicineRefills(now);
  const snapshot = await db
    .collection("medicineSchedules")
    .where("date", "==", today)
    .where("status", "in", ["scheduled", "reminding"])
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
    const scheduleData = doc.data() || {};
    const scheduleRef = doc.ref;

    if (
      ["completed", "exception_pending"].includes(scheduleData.status)
    ) {
      summary.skippedCount++;
      continue;
    }

    const medicineId = doc.id;
    const patientId = scheduleData.patientId || "";
    const caregiverId = scheduleData.caregiverId || "";
    const medicineName =
      (scheduleData.medicineItems || [])
        .map((item) => item?.name)
        .filter(Boolean)
        .join("、") ||
      "藥物";
    const medicineTime = scheduleData.time || "";
    const doseIndex = scheduleData.slotIndex || 1;
    const totalDoses = 1;
    const scheduledAt =
      scheduleData.scheduledAt?.toDate?.() ||
      buildScheduledDate(scheduleData.date, medicineTime);
    const cycle = getReminderCycle({
      scheduledAt,
      now,
      isDone: false,
    });
    const reminderKey = buildReminderKey(
      medicineId,
      scheduleData.date || "",
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
        medicineRef: scheduleRef,
        cycle,
      });

      if (!claim.claimed) {
        summary.skippedCount++;
        continue;
      }

      summary.claimedCount++;
      if (scheduleData.status === "scheduled") {
        await scheduleRef.set(
          {
            status: "reminding",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
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

async function checkDailyMedicineRefills(now = new Date()) {
  const taipeiTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Taipei",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  const [hour, minute] = taipeiTime.split(":").map(Number);

  if (hour !== 8 || minute > 4) return;

  const dateText = taipeiDateText(now);
  const claimRef = db
    .collection("systemJobs")
    .doc(`medicine-refill-${dateText.replace(/\//g, "")}`);
  const claimed = await db.runTransaction(async (transaction) => {
    const claim = await transaction.get(claimRef);
    if (claim.exists) return false;
    transaction.create(claimRef, {
      type: "medicine_refill_check",
      date: dateText,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return true;
  });

  if (!claimed) return;

  const schedulesSnapshot = await db
    .collection("medicineSchedules")
    .where("date", "==", dateText)
    .get();
  const schedulesByPatient = new Map();

  for (const doc of schedulesSnapshot.docs) {
    const schedule = { id: doc.id, ...doc.data() };
    const list = schedulesByPatient.get(schedule.patientId) || [];
    list.push(schedule);
    schedulesByPatient.set(schedule.patientId, list);
  }

  for (const [patientId, schedules] of schedulesByPatient) {
    const deviceSnapshot = await db
      .collection("devices")
      .where("patientId", "==", patientId)
      .limit(1)
      .get();
    if (deviceSnapshot.empty) continue;

    const slots = deviceSnapshot.docs[0].data()?.status?.slots || [];
    const missingSlots = schedules
      .filter((schedule) => {
        const slot = slots.find(
          (item) => normalizeSlotIndex(item) === schedule.slotIndex
        );
        return !slot || slot.hasMedicine !== true;
      })
      .map((schedule) => schedule.slotIndex)
      .sort();

    if (missingSlots.length === 0) continue;
    const patientDoc = await db.collection("users").doc(patientId).get();
    const caregiverId = patientDoc.data()?.linkedCaregiverId || "";
    await sendMedicineEventNotification({
      userIds: [caregiverId],
      buildMessage: buildMedicineRefillMessage,
      title: "今日藥物尚未補齊",
      body: `${missingSlots.map((slot) => `第 ${slot} 格`).join("、")} 尚未放入今日藥包。`,
      data: {
        eventKey: `medicine-refill:${dateText}:${patientId}`,
        patientId,
        date: dateText,
        slotIndexes: missingSlots.join(","),
      },
    });
  }
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
