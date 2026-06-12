# Overdue Medicine Repeat Alert Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send an initial medicine alert at the scheduled time, repeat phone notification/vibration and medicine-box beeps every five minutes until completion, and persist medicine-box taken events without requiring the App to be open.

**Architecture:** Cloudflare continues calling Render every minute. Render computes a stable five-minute cycle from the original scheduled time, atomically claims each cycle, sends unfinished channels, and stops when `medicines.isDone` becomes true. ESP32 reports are converted into durable taken events and matched to the nearest due unfinished medicine.

**Tech Stack:** Node.js, Express, Firebase Admin/Firestore, FCM, Cloudflare Workers Cron, Flutter, Android notification channels, Node test runner, Flutter test

---

### Task 1: Five-Minute Reminder Cycle Logic

**Files:**
- Create: `repeat_reminder.js`
- Create: `test/repeat_reminder.test.js`

- [ ] Write failing tests for initial cycle, `+5/+10` repeat cycles, not-yet-due cycles, cross-midnight schedules, and completed medicine.
- [ ] Run `node --test test/repeat_reminder.test.js` and confirm failure because the module is missing.
- [ ] Implement `getReminderCycle({ scheduledAt, now, isDone })`, returning `initial`, `repeat-N`, or `null`, plus the cycle due time.
- [ ] Implement `shouldClaimCycle(delivery, cycleKey)` so a completed cycle is not sent again.
- [ ] Run `npm test` and commit `Add repeating medicine reminder cycle logic`.

### Task 2: Durable Taken Event Matching

**Files:**
- Create: `medicine_taken.js`
- Create: `test/medicine_taken.test.js`
- Modify: `server.js`

- [ ] Write failing tests that select the nearest due unfinished medicine for the same patient and reject future, completed, wrong-patient, or ambiguous candidates.
- [ ] Run the focused test and verify RED.
- [ ] Implement `selectMedicineForTakenEvent`.
- [ ] Update `/device/report` to detect new `taken=true` slot events using a durable event key, save the event, load due unfinished medicines, and atomically set the selected medicine to `isDone=true`.
- [ ] Keep Hall/lid fields unchanged.
- [ ] Run `npm test` and commit `Persist medicine box taken events`.

### Task 3: Repeat Delivery State and Scheduler

**Files:**
- Modify: `reminder_scheduler.js`
- Modify: `server.js`
- Modify: `test/reminder_scheduler.test.js`
- Modify: `test/repeat_reminder.test.js`

- [ ] Write failing tests for independent per-cycle phone/box delivery, five-minute advancement, buzzer-disabled completion, and stopping on `isDone`.
- [ ] Run focused tests and verify RED.
- [ ] Replace one-time completed delivery behavior with cycle fields: `currentCycleKey`, per-cycle channel flags, `repeatCount`, `scheduledMedicineAt`, and `nextRepeatAt`.
- [ ] Query all unfinished medicines whose scheduled date/time is at or before now so repeats continue across midnight.
- [ ] Claim each cycle with the existing Firestore lease transaction and send only unfinished cycle channels.
- [ ] Mark the medicine's legacy `reminderSent=true` after the initial cycle only.
- [ ] Run `npm test` and commit `Repeat overdue medicine alerts every five minutes`.

### Task 4: Background Vibration Payload

**Files:**
- Modify: `notification_payload.js`
- Modify: `test/notification_payload.test.js`

- [ ] Write failing assertions for channel `medicine_fcm_channel_v6`, Android priority `max`, public visibility, and vibration timings.
- [ ] Run the focused test and verify RED.
- [ ] Update reminder and overdue FCM payloads; add `buildMedicineOverdueMessage`.
- [ ] Run `npm test` and commit `Enable background medicine notification vibration`.

### Task 5: Flutter Notification Channel and Duplicate Removal

**Files:**
- Modify: `C:/Users/user/Desktop/retrocare_project/heal2_app/lib/main.dart`
- Modify: `C:/Users/user/Desktop/retrocare_project/heal2_app/test/notification_delivery_regression_test.dart`

- [ ] Add failing source-regression assertions for channel v6 and absence of the overdue-card `medicineAlert` side effect.
- [ ] Run `flutter test test/notification_delivery_regression_test.dart` and verify RED.
- [ ] Change the App FCM channel to v6 while preserving max importance and vibration pattern.
- [ ] Remove only the system notification/vibration call from `PatientMedicineWarningCard`; preserve its in-App notification record and warning display.
- [ ] Run `flutter test`, `flutter analyze`, and commit only if an App Git repository exists.

### Task 6: Deploy and Verify

**Files:**
- No additional planned source files.

- [ ] Run `npm test`, Worker tests, `node --check server.js`, Flutter tests, Flutter analyze, and Flutter APK build.
- [ ] Push backend `main` to GitHub and wait for Render root/cron endpoint health.
- [ ] Redeploy Cloudflare Worker if its source/config changed; otherwise verify the existing `* * * * *` schedule.
- [ ] Install the new APK on `emulator-5554`.
- [ ] Create a bounded test medicine and verify initial and five-minute repeat delivery state without falsely marking completion.
- [ ] Verify a simulated durable taken event stops later cycles, then remove all test data.
- [ ] Report that physical vibration and audible buzzer still require a real phone and medicine box.
