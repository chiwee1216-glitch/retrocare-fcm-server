# 智慧藥盒完整連動流程 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓四格智慧藥盒、雲端後端、病人端與看護端共用唯一服藥狀態，可靠處理提醒、正常取藥、異常取藥、補藥及雙端同步。

**Architecture:** ESP32 只上傳帶有唯一事件 ID 的開關蓋與檢測事件；Node.js 後端以 `medicineSchedules` 作為唯一狀態機，依 `slotIndex` 與預定時間前後 10 分鐘判定正常或異常；Flutter 以 Firestore snapshots 顯示狀態，不再自行猜測完成項目。原有 `medicines` 保留單一藥物資料，但透過 `scheduleId` 加入同一時間的服藥時段。

**Tech Stack:** Flutter/Dart、Firebase Auth、Cloud Firestore、Firebase Cloud Messaging、Node.js/Express/Firebase Admin、ESP32 Arduino、Node test runner、Flutter test。

---

## 檔案結構

### 後端

- Create: `medicine_schedule.js`：時段分組、四格分配、正常時間範圍與狀態轉換純函式。
- Create: `medicine_box_event.js`：事件去重、藥格匹配與異常原因判斷純函式。
- Create: `test/medicine_schedule.test.js`
- Create: `test/medicine_box_event.test.js`
- Modify: `server.js`：建立／同步時段、處理硬體事件、異常確認、補藥檢查及通知。
- Modify: `notification_payload.js`：新增藥物、異常取藥及補藥 data-only payload。
- Modify: `test/notification_payload.test.js`
- Modify: `repeat_reminder.js`：只對 `reminding` 狀態建立每 5 分鐘週期。
- Modify: `test/repeat_reminder.test.js`

### Flutter App

- Create: `lib/medicine_schedule.dart`：時段與藥格 ViewModel、排序與狀態文字。
- Create: `lib/medicine_box_realtime.dart`：Firestore 藥盒／時段即時訂閱。
- Create: `test/medicine_schedule_test.dart`
- Create: `test/medicine_box_realtime_test.dart`
- Modify: `lib/medicine_push.dart`：新增推播類型與去重欄位。
- Modify: `lib/main.dart`：移除最近時間完成猜測、接入即時資料、雙向藥物／藥格管理、異常確認、通知震動、天氣及畫面。
- Modify: `test/notification_delivery_regression_test.dart`
- Modify: `firestore.rules`

### ESP32

- Modify: `C:\Users\user\Desktop\藥盒\box\box.ino`：四格統一編號、事件佇列、開關蓋即時回報、關蓋 LED 檢測及較敏感碰撞偵測。
- Modify: `C:\Users\user\Desktop\藥盒\box\verify_firmware_contract.ps1`

---

### Task 1: 建立服藥時段與四格分配核心

**Files:**
- Create: `medicine_schedule.js`
- Create: `test/medicine_schedule.test.js`

- [ ] **Step 1: 撰寫失敗測試**

```js
test("groups medicines by patient date and time and assigns four slots", () => {
  const schedules = buildDailySchedules([
    { id: "a", patientId: "p1", date: "2026/06/15", time: "14:00", name: "血壓藥" },
    { id: "b", patientId: "p1", date: "2026/06/15", time: "14:00", name: "胃藥" },
    { id: "c", patientId: "p1", date: "2026/06/15", time: "16:00", name: "降血糖藥" },
  ]);

  assert.equal(schedules.length, 2);
  assert.equal(schedules[0].slotIndex, 1);
  assert.deepEqual(schedules[0].medicineIds, ["a", "b"]);
  assert.equal(schedules[1].slotIndex, 2);
});

test("rejects a fifth distinct medicine time", () => {
  assert.throws(
    () => buildDailySchedules([
      { id: "a", patientId: "p1", date: "2026/06/15", time: "08:00", name: "A" },
      { id: "b", patientId: "p1", date: "2026/06/15", time: "10:00", name: "B" },
      { id: "c", patientId: "p1", date: "2026/06/15", time: "12:00", name: "C" },
      { id: "d", patientId: "p1", date: "2026/06/15", time: "14:00", name: "D" },
      { id: "e", patientId: "p1", date: "2026/06/15", time: "16:00", name: "E" },
    ]),
    /最多支援四個服藥時段/
  );
});

test("uses a ten minute normal window", () => {
  const window = buildNormalWindow("2026/06/15", "16:00");
  assert.equal(window.start.toISOString(), "2026-06-15T07:50:00.000Z");
  assert.equal(window.end.toISOString(), "2026-06-15T08:10:00.000Z");
});
```

- [ ] **Step 2: 執行測試並確認失敗**

Run: `node --test test/medicine_schedule.test.js`

Expected: FAIL，原因為 `medicine_schedule.js` 或匯出函式不存在。

- [ ] **Step 3: 實作純函式**

```js
const MAX_SLOT_COUNT = 4;

function normalizeDate(value) {
  return String(value || "").replace(/-/g, "/");
}

function scheduleKey({ patientId, date, time }) {
  return `${patientId}:${normalizeDate(date)}:${String(time || "").trim()}`;
}

function buildScheduledAt(date, time) {
  const normalized = normalizeDate(date).replace(/\//g, "-");
  const value = new Date(`${normalized}T${time}:00+08:00`);
  if (Number.isNaN(value.getTime())) throw new Error("服藥日期或時間格式錯誤");
  return value;
}

function buildNormalWindow(date, time) {
  const scheduledAt = buildScheduledAt(date, time);
  return {
    scheduledAt,
    start: new Date(scheduledAt.getTime() - 10 * 60 * 1000),
    end: new Date(scheduledAt.getTime() + 10 * 60 * 1000),
  };
}

function buildDailySchedules(medicines) {
  const groups = new Map();
  for (const medicine of medicines) {
    const key = scheduleKey(medicine);
    const group = groups.get(key) || {
      patientId: medicine.patientId,
      caregiverId: medicine.caregiverId || "",
      date: normalizeDate(medicine.date),
      time: medicine.time,
      medicineIds: [],
      medicineItems: [],
    };
    group.medicineIds.push(medicine.id);
    group.medicineItems.push({ id: medicine.id, name: medicine.name || "藥物" });
    groups.set(key, group);
  }

  const schedules = [...groups.values()].sort((a, b) => a.time.localeCompare(b.time));
  if (schedules.length > MAX_SLOT_COUNT) {
    throw new Error("藥盒一天最多支援四個服藥時段");
  }

  return schedules.map((schedule, index) => {
    const window = buildNormalWindow(schedule.date, schedule.time);
    return {
      ...schedule,
      slotIndex: index + 1,
      status: "scheduled",
      scheduledAt: window.scheduledAt,
      normalWindowStart: window.start,
      normalWindowEnd: window.end,
    };
  });
}

module.exports = { buildDailySchedules, buildNormalWindow, scheduleKey };
```

- [ ] **Step 4: 執行測試**

Run: `node --test test/medicine_schedule.test.js`

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add medicine_schedule.js test/medicine_schedule.test.js
git commit -m "Add medicine schedule slot model"
```

### Task 2: 建立藥盒事件與正常／異常判定

**Files:**
- Create: `medicine_box_event.js`
- Create: `test/medicine_box_event.test.js`
- Modify: `server.js`
- Remove behavior from: `medicine_taken.js`

- [ ] **Step 1: 撰寫事件判定失敗測試**

```js
test("completes only the schedule assigned to the removed slot", () => {
  const result = classifyPackageRemoved({
    slotIndex: 2,
    occurredAt: new Date("2026-06-15T08:05:00.000Z"),
    schedules: [
      schedule({ id: "s1", slotIndex: 1, time: "16:00" }),
      schedule({ id: "s2", slotIndex: 2, time: "16:00" }),
    ],
  });
  assert.equal(result.kind, "normal");
  assert.equal(result.scheduleId, "s2");
});

test("marks wrong slot or outside ten minutes as exception", () => {
  assert.equal(classifyPackageRemoved({
    slotIndex: 3,
    occurredAt: new Date("2026-06-15T08:20:00.000Z"),
    schedules: [schedule({ id: "s2", slotIndex: 3, time: "16:00" })],
  }).kind, "exception");
});

test("deduplicates repeated firmware event ids", () => {
  assert.equal(shouldProcessEvent({ eventId: "boot1-42", processedEventIds: ["boot1-42"] }), false);
});
```

- [ ] **Step 2: 執行並確認失敗**

Run: `node --test test/medicine_box_event.test.js`

Expected: FAIL，函式尚不存在。

- [ ] **Step 3: 實作事件分類**

```js
function shouldProcessEvent({ eventId, processedEventIds = [] }) {
  return Boolean(eventId) && !processedEventIds.includes(eventId);
}

function classifyPackageRemoved({ slotIndex, occurredAt, schedules }) {
  const schedule = schedules.find(
    (item) =>
      item.slotIndex === slotIndex &&
      !["completed", "exception_pending"].includes(item.status)
  );
  if (!schedule) return { kind: "exception", reason: "unassigned_slot" };

  const millis = occurredAt.getTime();
  const start = schedule.normalWindowStart.getTime();
  const end = schedule.normalWindowEnd.getTime();
  if (millis < start || millis > end) {
    return { kind: "exception", reason: "outside_normal_window", scheduleId: schedule.id };
  }
  return { kind: "normal", scheduleId: schedule.id };
}

module.exports = { shouldProcessEvent, classifyPackageRemoved };
```

- [ ] **Step 4: 改寫 `/device/report`**

`server.js` 接收：

```json
{
  "status": { "slots": [] },
  "events": [
    {
      "eventId": "boot-123:42",
      "eventType": "package_removed",
      "slotIndex": 2,
      "occurredAtMillis": 1781510700000,
      "hasMedicineBefore": true,
      "hasMedicineAfter": false,
      "ldrRaw": 287,
      "hallRaw": 0
    }
  ]
}
```

在 Firestore transaction 中：

1. 以 `medicineBoxEvents/{eventId}` 是否存在去重。
2. 查詢該病人當日 `medicineSchedules`。
3. 正常事件將 schedule 更新為 `completed`，並批次將 `medicineIds` 對應的 `medicines.isDone` 設為 true。
4. 異常事件建立 `medicineExceptions`，schedule 設為 `exception_pending`。
5. 停止呼叫 `selectMedicineForTakenEvent`。

- [ ] **Step 5: 執行後端全部測試**

Run: `npm test`

Expected: 所有測試通過；舊的「最近時間」測試改成藥格匹配測試。

- [ ] **Step 6: 提交**

```powershell
git add medicine_box_event.js test/medicine_box_event.test.js server.js medicine_taken.js test/medicine_taken.test.js
git commit -m "Match medicine completion by slot event"
```

### Task 3: 同步建立藥物與服藥時段

**Files:**
- Modify: `server.js`
- Modify: `medicine_schedule.js`
- Create: `test/medicine_schedule_sync.test.js`

- [ ] **Step 1: 撰寫同步測試**

測試 `buildScheduleWrites()`：

- 同一病人、日期、時間的三種藥產生一個 schedule。
- 三筆 medicines 都取得相同 `scheduleId`。
- 修改時間後重新排序 `slotIndex`。
- 第五個不同時間回傳 HTTP 409 與中文錯誤。

- [ ] **Step 2: 建立受 Firebase ID token 保護的 API**

新增：

```text
POST /medicine-schedules/sync
```

Request:

```json
{
  "patientId": "patient-uid",
  "date": "2026/06/15"
}
```

後端讀取當日 medicines，呼叫 `buildDailySchedules`，transaction 寫入：

- `medicineSchedules/{patientId_yyyyMMdd_HHmm}`
- 每筆 `medicines/{id}.scheduleId`
- 刪除當日已不存在的舊 schedule，但保留有完成／異常紀錄的歷史文件。

- [ ] **Step 3: 在新增、修改、刪除藥物後同步**

Flutter 不直接建立 schedule；儲存 medicines 成功後呼叫 `/medicine-schedules/sync`。若同步回傳 409，復原本次新增／修改並顯示「藥盒一天最多支援四個服藥時段」。

- [ ] **Step 4: 執行測試**

Run: `npm test`

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add server.js medicine_schedule.js test/medicine_schedule_sync.test.js
git commit -m "Synchronize medicine schedules and slots"
```

### Task 4: ESP32 改為事件式回報與四格統一編號

**Files:**
- Modify: `C:\Users\user\Desktop\藥盒\box\box.ino`
- Modify: `C:\Users\user\Desktop\藥盒\box\verify_firmware_contract.ps1`

- [ ] **Step 1: 先擴充韌體契約檢查**

PowerShell 檢查必須找到：

```powershell
Assert-Contains 'String slotNames[SLOT_COUNT] = { "第 1 格", "第 2 格", "第 3 格", "第 4 格" }'
Assert-Contains 'eventType'
Assert-Contains 'eventId'
Assert-Contains 'slotIndex'
Assert-Contains 'queueMedicineBoxEvent'
Assert-Contains 'flushMedicineBoxEvents'
Assert-Contains 'runLedCheck(changedSlotIndex)'
```

- [ ] **Step 2: 執行契約並確認失敗**

Run:

```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\user\Desktop\藥盒\box\verify_firmware_contract.ps1
```

Expected: FAIL，舊韌體仍使用早上格等名稱且沒有事件佇列。

- [ ] **Step 3: 實作固定大小事件佇列**

新增：

```cpp
struct MedicineBoxEvent {
  String eventId;
  String eventType;
  int slotIndex;
  unsigned long occurredAtMillis;
  bool hasMedicineBefore;
  bool hasMedicineAfter;
  int ldrRaw;
  int hallRaw;
};

MedicineBoxEvent eventQueue[16];
int eventQueueHead = 0;
int eventQueueCount = 0;
String bootId;
unsigned long nextEventSequence = 1;
```

`queueMedicineBoxEvent()` 產生 `${bootId}:${sequence}`，網路失敗時保留事件，下次 `/device/report` 成功後才移除。

- [ ] **Step 4: 開關蓋立即建立事件**

- 防抖確認開蓋後建立 `lid_opened`。
- 防抖確認關蓋後建立 `lid_closed`，立即執行該格 LED 檢測。
- 檢測由有藥變無藥時建立 `package_removed`。
- App 手動 `check_led` 時檢查四格，但只有真正由有藥變無藥的格建立 package event。

- [ ] **Step 5: 調整 LED 時序**

移除 `runLedCheck()` 內阻塞式 `delay(300)`，改成非阻塞狀態：

```cpp
enum LedCheckState { LED_IDLE, LED_SETTLING, LED_READING, LED_HOLDING };
```

LED 開啟後 300ms 讀取 LDR，從開啟起滿 2000ms 關閉，期間仍持續處理 WebServer、雲端回報及霍爾事件。

- [ ] **Step 6: 恢復較敏感碰撞參數**

先將：

```cpp
const float IMPACT_G_THRESHOLD = 2.2;
const float IMPACT_DELTA_THRESHOLD = 1.0;
const unsigned long STILL_TIME = 1800;
const unsigned long FALL_ALERT_COOLDOWN_MS = 30000;
```

同一冷卻期內只上傳一次 `fall_detected`。

- [ ] **Step 7: 執行契約檢查**

Expected: PASS。

- [ ] **Step 8: 保存韌體版本**

將 `firmwareVersion` 提升至 `1.3.0`，並保存待燒錄檔案。ESP32 目錄不是目前後端 git repo，不建立混合提交。

### Task 5: Flutter 改為 Firestore 即時監聽

**Files:**
- Create: `C:\Users\user\Desktop\retrocare_project\heal2_app\lib\medicine_box_realtime.dart`
- Create: `C:\Users\user\Desktop\retrocare_project\heal2_app\test\medicine_box_realtime_test.dart`
- Modify: `C:\Users\user\Desktop\retrocare_project\heal2_app\lib\main.dart`

- [ ] **Step 1: 撰寫狀態映射測試**

```dart
test('maps all four cloud slots without polling', () {
  final slots = mapCloudSlots([
    {'slotIndex': 1, 'lidOpen': false, 'hasMedicine': false},
    {'slotIndex': 2, 'lidOpen': true, 'hasMedicine': true},
    {'slotIndex': 3, 'lidOpen': false, 'hasMedicine': true},
    {'slotIndex': 4, 'lidOpen': false, 'hasMedicine': false},
  ]);
  expect(slots.map((e) => e.label), ['第 1 格', '第 2 格', '第 3 格', '第 4 格']);
  expect(slots[1].lidOpen, isTrue);
});
```

- [ ] **Step 2: 建立即時控制器**

```dart
class MedicineBoxRealtimeController {
  StreamSubscription<DocumentSnapshot<Map<String, dynamic>>>? _deviceSub;
  StreamSubscription<QuerySnapshot<Map<String, dynamic>>>? _scheduleSub;

  Future<void> start({required String deviceId, required String patientId}) async {
    await stop();
    _deviceSub = FirebaseFirestore.instance
        .collection('devices').doc(deviceId).snapshots().listen(_handleDevice);
    _scheduleSub = FirebaseFirestore.instance
        .collection('medicineSchedules')
        .where('patientId', isEqualTo: patientId)
        .snapshots().listen(_handleSchedules);
  }

  Future<void> stop() async {
    await _deviceSub?.cancel();
    await _scheduleSub?.cancel();
  }
}
```

- [ ] **Step 3: 移除藥盒輪詢**

刪除或停用：

```dart
Timer.periodic(const Duration(seconds: 2), ...)
MedicineBoxEsp32Service._completeMedicinesFromBox(...)
```

保留區域網路自動搜尋與手動連線測試，但它們不再負責日常狀態更新。

- [ ] **Step 4: 執行 Flutter 測試**

Run: `flutter test test/medicine_box_realtime_test.dart`

Expected: PASS。

- [ ] **Step 5: 執行完整測試**

Run: `flutter test`

Expected: PASS。

### Task 6: 雙向連動藥物設定、藥格管理與今日任務

**Files:**
- Create: `C:\Users\user\Desktop\retrocare_project\heal2_app\lib\medicine_schedule.dart`
- Create: `C:\Users\user\Desktop\retrocare_project\heal2_app\test\medicine_schedule_test.dart`
- Modify: `C:\Users\user\Desktop\retrocare_project\heal2_app\lib\main.dart`
- Modify: `C:\Users\user\Desktop\retrocare_project\heal2_app\firestore.rules`

- [ ] **Step 1: 撰寫 ViewModel 測試**

測試：

- 相同時間三種藥顯示一個「第 1 次」。
- 第 1 至第 4 格按時間排序。
- `exception_pending` 顯示「異常取藥・待看護確認」。
- 看護一般任務沒有可勾選完成的 callback。
- 第五個不同時間回傳表單錯誤。

- [ ] **Step 2: 建立時段 ViewModel**

```dart
class MedicineScheduleViewModel {
  final String id;
  final int slotIndex;
  final String date;
  final String time;
  final List<String> medicineNames;
  final String status;
  final DateTime? actualTakenAt;

  String get slotLabel => '第 $slotIndex 格';
  String get doseLabel => '第 $slotIndex 次';
}
```

- [ ] **Step 3: 修改服用藥物設定**

儲存前取得該病人、該日期的不同時間集合；新增後超過四個時間時阻止。儲存 medicines 後呼叫 schedule sync API，並使用回傳的 `scheduleId` 與 `slotIndex` 更新畫面。

- [ ] **Step 4: 新增「管理今日藥格」頁**

保留已核准的主要畫面；看護端今日任務右上方新增管理入口。管理頁顯示四格，支援：

- 編輯整個時段時間。
- 新增／移除同包藥物。
- 未使用藥格新增時段。
- 時間變動後預覽重新排序再確認。

- [ ] **Step 5: 看護端只讀完成狀態**

一般今日任務移除 checkbox；異常卡只提供：

```text
確認已服用
誤取／未服用
```

兩個按鈕呼叫受驗證後端 API，不直接寫 Firestore 狀態。

- [ ] **Step 6: 更新 Firestore rules**

允許病人與綁定看護讀取 `medicineSchedules`、`medicineBoxEvents`、`medicineExceptions`；禁止客戶端直接修改 schedule 狀態與 exception resolution，這些只能由 Admin SDK 後端寫入。

- [ ] **Step 7: 執行測試**

Run:

```powershell
flutter test
flutter analyze
```

Expected: 測試通過；analyze 不新增 error。

### Task 7: 完成通知、異常確認與補藥提醒

**Files:**
- Modify: `server.js`
- Modify: `notification_payload.js`
- Modify: `repeat_reminder.js`
- Modify: `test/notification_payload.test.js`
- Modify: `test/repeat_reminder.test.js`
- Modify: `C:\Users\user\Desktop\retrocare_project\heal2_app\lib\medicine_push.dart`
- Modify: `C:\Users\user\Desktop\retrocare_project\heal2_app\lib\main.dart`
- Modify: `C:\Users\user\Desktop\retrocare_project\heal2_app\test\notification_delivery_regression_test.dart`

- [ ] **Step 1: 擴充 data-only 推播類型測試**

允許：

```text
medicine_created
medicine_reminder
medicine_overdue_reminder
medicine_exception
medicine_refill_missing
```

所有 payload 必須有 `eventKey`，App 以此去重。`medicine_created` 使用 `creationBatchId`，一次新增多時段仍只發一次。

- [ ] **Step 2: 新增藥物雙端通知與震動**

後端收集病人與其看護 token，發送同一 `creationBatchId`。App 對 `medicine_created` 呼叫 `medicineAlert()`，但不排程蜂鳴器。

- [ ] **Step 3: 調整每 5 分鐘提醒**

只處理 schedule status 為 `reminding` 的文件。當狀態變為 `completed` 或 `exception_pending`，下一輪立即跳過，不再通知或蜂鳴。

- [ ] **Step 4: 新增異常確認 API**

```text
POST /medicine-exceptions/:id/resolve
```

Body:

```json
{ "resolution": "confirmed_taken" }
```

或：

```json
{ "resolution": "confirmed_not_taken" }
```

驗證登入者是綁定看護。前者完成 schedule 與 medicines；後者設回 `reminding` 並將下一提醒時間設為現在。

- [ ] **Step 5: 新增 08:00 補藥檢查**

Cloudflare cron 現有分鐘觸發可共用同一入口；後端在台北時間 08:00 至 08:04 每日只 claim 一次補藥檢查。只檢查當日有 schedule 的 slot，缺藥時發送 `medicine_refill_missing` 給看護。

- [ ] **Step 6: 執行後端與 Flutter 測試**

Run:

```powershell
npm test
flutter test
```

Expected: 全部通過。

- [ ] **Step 7: 提交後端**

```powershell
git add server.js notification_payload.js repeat_reminder.js test
git commit -m "Add unified medicine alerts and exception handling"
```

### Task 8: 修正天氣與碰撞顯示

**Files:**
- Modify: `C:\Users\user\Desktop\retrocare_project\heal2_app\lib\main.dart`
- Create: `C:\Users\user\Desktop\retrocare_project\heal2_app\test\weather_location_test.dart`
- Modify: `C:\Users\user\Desktop\藥盒\box\box.ino`

- [ ] **Step 1: 抽出天氣位置決策並測試**

測試 GPS 新鮮資料、權限拒絕、逾時及備援位置。天氣 ViewModel 必須包含：

```dart
locationLabel
locationSource // gps 或 fallback
updatedAt
isFallback
```

- [ ] **Step 2: 修正天氣畫面**

顯示目前手機定位名稱、資料更新時間、目前溫度、體感溫度、降雨機率；使用備援位置時顯示「定位失敗，目前顯示預設位置」。

- [ ] **Step 3: 實機校正碰撞**

將 ESP32 Serial 同時輸出 `accelG`、`deltaG`、state 與 cooldown，依以下四種測試記錄結果：

1. 手持輕微晃動：不得持續觸發。
2. 桌面旁放物品：最多碰撞警示，不得重複推送。
3. 快速移動藥盒：可觸發敏感事件。
4. 模擬跌落後靜止：需觸發跌倒。

- [ ] **Step 4: 執行 Flutter 測試**

Run: `flutter test`

Expected: PASS。

### Task 9: 部署與完整端到端驗收

**Files:**
- Verify: backend repository
- Verify: Flutter APK
- Flash: `C:\Users\user\Desktop\藥盒\box\box.ino`

- [ ] **Step 1: 執行後端驗證**

```powershell
npm test
node --check server.js
git diff --check
```

Expected: exit 0。

- [ ] **Step 2: 執行 Flutter 驗證**

```powershell
flutter test
flutter analyze
flutter build apk --debug
```

Expected: 測試與 build 成功；analyze 無 error。

- [ ] **Step 3: 部署後端**

推送後端 branch，確認 Render 使用新 commit；以授權 cron request 確認 endpoint 回傳成功摘要。

- [ ] **Step 4: 燒錄 ESP32 1.3.0**

確認 Serial 顯示 Wi-Fi、device report HTTP 2xx、四格 slotIndex 與事件 ID。

- [ ] **Step 5: 安裝實體手機 APK**

保留 App 資料安裝：

```powershell
adb -s 10AF770H2B002U9 install -r build\app\outputs\flutter-apk\app-debug.apk
```

- [ ] **Step 6: 逐格驗收**

第 1、2、3、4 格各自執行：

1. 開蓋，兩端 2 秒內顯示開蓋。
2. 不取藥關蓋，LED 亮 2 秒，保持未完成。
3. 正常時間取藥，正確時段全部完成。
4. 錯誤時間取藥，雙端通知／震動、蜂鳴器及待確認。
5. 看護兩種處理結果均符合規格。

- [ ] **Step 7: 背景提醒驗收**

App 關閉並鎖定手機，驗證：

- 新增藥物雙端各通知震動一次。
- 預定時間通知震動與蜂鳴器。
- 未完成每 5 分鐘重複。
- 提早正常完成後不再提醒。
- 滑掉通知不產生第二條延遲通知。

- [ ] **Step 8: 補藥與天氣驗收**

- 用測試時鐘或管理 endpoint 模擬 08:00 未補藥，確認只通知看護一次。
- 補齊後 LED 檢測解除警示。
- 比較 App GPS 座標與 Open-Meteo request 座標，確認位置來源與更新時間顯示正確。

- [ ] **Step 9: 最終提交與部署紀錄**

只提交本次變更，不加入 `.idea`、`.superpowers` 或其他使用者檔案。記錄後端 commit、APK 時間、韌體版本與實機驗收結果。
