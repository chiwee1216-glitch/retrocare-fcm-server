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

    if (!patientId) {
      return res.status(400).json({
        success: false,
        message: "缺少 patientId",
      });
    }

    const patientDoc = await db.collection("users").doc(patientId).get();

    if (!patientDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "找不到病人資料",
      });
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
      return res.json({
        success: false,
        message: "沒有可推播的 FCM Token",
      });
    }

    const title = `服藥提醒：${medicineName || "藥物"}`;
    const body = `第 ${doseIndex || 1} 次 / 共 ${totalDoses || 1} 次，時間 ${medicineTime || ""}，請記得服藥`;

    const message = {
      notification: {
        title,
        body,
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

    return res.json({
      success: true,
      successCount: response.successCount,
      failureCount: response.failureCount,
    });
  } catch (error) {
    console.error("推播失敗：", error);

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