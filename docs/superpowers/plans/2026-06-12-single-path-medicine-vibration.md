# Single-Path Medicine Vibration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route medicine reminders through one App-controlled notification path that reliably vibrates once.

**Architecture:** Render sends scheduled and overdue reminders as high-priority data-only FCM. Flutter validates the payload, deduplicates by cycle key, and creates the vibrating local alarm notification. Informational medicine-created pushes remain normal system notifications.

**Tech Stack:** Node.js, Firebase Admin FCM, FlutterFire Messaging, flutter_local_notifications, vibration, Android

---

### Task 1: Data-Only Medicine Payload

**Files:**
- Modify: `notification_payload.js`
- Modify: `test/notification_payload.test.js`

- [ ] Write a failing test that expects reminder and overdue messages to omit
  `notification` and `android.notification`, retain `android.priority = high`,
  and include `title`, `body`, `type`, and `reminderCycleKey` in `data`.
- [ ] Run `node --test test/notification_payload.test.js` and confirm RED.
- [ ] Split the payload builder so medicine-created messages retain the current
  system notification while medicine reminders are data-only.
- [ ] Run `npm test` and confirm all tests pass.

### Task 2: Validated Background Alert

**Files:**
- Modify: `C:/Users/user/Desktop/retrocare_project/heal2_app/lib/main.dart`
- Modify: `C:/Users/user/Desktop/retrocare_project/heal2_app/test/notification_delivery_regression_test.dart`

- [ ] Add failing source-regression tests requiring supported medicine types,
  non-empty title/body/cycle key validation, and notification delegation
  disablement.
- [ ] Run the focused Flutter test and confirm RED.
- [ ] Add a pure payload validator, ignore malformed/unknown messages, derive the
  notification ID from `reminderCycleKey`, and call `medicineAlert`.
- [ ] Disable Android notification delegation during FCM initialization.
- [ ] Run Flutter tests and build the debug APK.

### Task 3: Deploy and Real-Phone Verification

**Files:**
- No additional planned source files.

- [ ] Commit and push backend `main`, then verify Render health.
- [ ] Install the APK on device `10AF770H2B002U9`.
- [ ] Background the App and send one data-only medicine test message.
- [ ] Verify one notification, one background-handler log, and one completed
  ALARM vibration record.
- [ ] Remove the test notification and report the result.

