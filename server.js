const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const app = express();

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

const message = {
  data: {
    type: "medicine_reminder",
    title: title,
    body: body,
    patientId: patientId,
    medicineName: medicineName || "",
    medicineTime: medicineTime || "",
    reminderKey: reminderKey || "",
  },
  android: {
    priority: "high",
  },
  tokens: allTokens,
};
  const response = await admin.messaging().sendEachForMulticast(message);

  return {
    success: true,
    successCount: response.successCount,
    failureCount: response.failureCount,
  };
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
    const result = await admin.messaging().sendEachForMulticast({
      tokens,
      data: {
        type: "medicine_created",
        title,
        body,
        patientId,
        medicineName: medicineName || "",
        medicineDate: medicineDate || "",
        medicineTimes: JSON.stringify(times),
        medicineIds: JSON.stringify(ids),
      },
      android: {
        priority: "high",
      },
    });

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

async function checkMedicineReminders() {
    const today = getTodayTaipeiDateText();
    const nowTime = getNowTaipeiTimeText();
    const nowMinutes = timeTextToMinutes(nowTime);

    console.log(`開始檢查服藥提醒：date=${today}, time=${nowTime}`);

    const snapshot = await db
      .collection("medicines")
      .where("date", "==", today)
      .where("isDone", "==", false)
      .get();

    let checkedCount = 0;
    let sentCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const doc of snapshot.docs) {
      checkedCount++;

      const data = doc.data();

      const medicineId = doc.id;
      const patientId = data.patientId || "";
      const caregiverId = data.caregiverId || "";
      const medicineName = data.name || "藥物";
      const medicineTime = data.time || "";
      const doseIndex = data.doseIndex || 1;
      const totalDoses = parseInt(data.times || "1", 10) || 1;
      const reminderSent = data.reminderSent === true;
      const medicineMinutes = timeTextToMinutes(medicineTime);

      if (!patientId || medicineMinutes === null || nowMinutes === null) {
        skippedCount++;
        continue;
      }

      // 還沒到時間
      if (medicineMinutes > nowMinutes) {
        skippedCount++;
        continue;
      }

      // 已經發過，避免重複推播
      if (reminderSent) {
        skippedCount++;
        continue;
      }

      // 避免伺服器重新部署時一次補送很久以前的舊提醒。
      if (nowMinutes - medicineMinutes > 10) {
        await doc.ref.set(
          {
            reminderExpired: true,
            reminderExpiredAt:
              admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        skippedCount++;
        continue;
      }

      try {
        const result = await sendMedicineNotification({
          patientId,
          caregiverId,
          medicineName,
          medicineTime,
          doseIndex,
          totalDoses,
          reminderKey: `${medicineId}_${today}_${medicineTime}`,
        });
        const medicineBoxResult = await queueMedicineBoxCommand(
          patientId,
          "beep"
        );

        await db.collection("medicines").doc(medicineId).set(
          {
            reminderSent: true,
            reminderSentAt: admin.firestore.FieldValue.serverTimestamp(),
            reminderResult: result,
            medicineBoxReminderResult: medicineBoxResult,
          },
          { merge: true }
        );

        sentCount++;

        console.log(`已推播服藥提醒：${medicineName} ${medicineTime}`);
      } catch (error) {
        failedCount++;

        console.error(`服藥提醒推播失敗 medicineId=${medicineId}`, error);

        await db.collection("medicines").doc(medicineId).set(
          {
            reminderError: error.message,
            reminderErrorAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
    }

    return {
      success: true,
      today,
      nowTime,
      checkedCount,
      sentCount,
      skippedCount,
      failedCount,
    };
}

// 檢查服藥時間，到時間就推播
app.get("/check-medicine-reminders", async (req, res) => {
  try {
    return res.json(await checkMedicineReminders());
  } catch (error) {
    console.error("檢查服藥提醒失敗：", error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`RetroCare FCM Server running on port ${PORT}`);
});

let reminderCheckRunning = false;

setInterval(async () => {
  if (reminderCheckRunning) return;
  reminderCheckRunning = true;

  try {
    const result = await checkMedicineReminders();
    if (result.sentCount > 0 || result.failedCount > 0) {
      console.log("定時服藥檢查結果：", result);
    }
  } catch (error) {
    console.error("定時服藥檢查失敗：", error);
  } finally {
    reminderCheckRunning = false;
  }
}, 30000);
