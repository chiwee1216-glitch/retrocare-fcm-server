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

async function sendMedicineNotification({
  patientId,
  caregiverId,
  medicineName,
  medicineTime,
  doseIndex,
  totalDoses,
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
  notification: {
    title,
    body,
  },
  android: {
    priority: "high",
    notification: {
      channelId: "medicine_fcm_channel_v5",
      sound: "default",
      defaultSound: true,
      defaultVibrateTimings: true,
      visibility: "public",
      notificationPriority: "PRIORITY_MAX",
    },
  },
  data: {
    type: "medicine_reminder",
    patientId: patientId,
    medicineName: medicineName || "",
    medicineTime: medicineTime || "",
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
    } = req.body;

    const result = await sendMedicineNotification({
      patientId,
      caregiverId,
      medicineName,
      medicineTime,
      doseIndex,
      totalDoses,
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

// 新增：檢查服藥時間，到時間就推播
app.get("/check-medicine-reminders", async (req, res) => {
  try {
    const today = getTodayTaipeiDateText();
    const nowTime = getNowTaipeiTimeText();

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

      if (!patientId || !medicineTime) {
        skippedCount++;
        continue;
      }

      // 還沒到時間
      if (medicineTime > nowTime) {
        skippedCount++;
        continue;
      }

      // 已經發過，避免重複推播
      if (reminderSent) {
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
        });

        await db.collection("medicines").doc(medicineId).set(
          {
            reminderSent: true,
            reminderSentAt: admin.firestore.FieldValue.serverTimestamp(),
            reminderResult: result,
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

    return res.json({
      success: true,
      today,
      nowTime,
      checkedCount,
      sentCount,
      skippedCount,
      failedCount,
    });
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