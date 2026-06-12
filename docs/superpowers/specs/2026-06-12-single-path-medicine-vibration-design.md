# Single-Path Medicine Vibration Design

## Goal

Make scheduled and overdue medicine reminders vibrate reliably on the tested
vivo phone while showing exactly one notification per reminder cycle.

## Root Cause

Medicine messages currently contain both `notification` and `data`. Google Play
services can proxy the system notification while FlutterFire also delivers a
background callback. On the tested phone, the proxied notification does not
vibrate, while the App-created alarm notification does. The two paths can also
arrive at different times and create a delayed fallback notification.

## Design

- Scheduled and overdue medicine reminders use high-priority data-only FCM.
- Medicine-created informational pushes keep their existing system notification
  payload.
- The Flutter background handler accepts only `medicine_reminder` and
  `medicine_overdue_reminder` messages with non-empty title, body, and
  reminder-cycle key.
- The App creates the one visible notification and calls its proven
  `medicineAlert` vibration path.
- The notification ID is derived from the reminder-cycle key. Duplicate
  delivery of the same cycle replaces the existing notification and does not
  start another vibration.
- Android notification delegation is disabled for this app instance so Google
  Play services cannot create a second proxied notification.

## Verification

- Node payload tests prove medicine reminders are data-only and medicine-created
  pushes still have a notification payload.
- Flutter regression tests prove invalid messages are ignored and valid
  medicine messages use the local alert path.
- A real-phone FCM test verifies one notification and one recorded ALARM
  vibration while the App is backgrounded.

