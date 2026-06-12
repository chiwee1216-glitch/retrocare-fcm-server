# Cloudflare Reminder Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Render's in-process timer as the primary reminder trigger with a free Cloudflare Cron Worker while making reminder delivery authenticated, idempotent, and retryable.

**Architecture:** A Cloudflare Worker calls a protected Render endpoint every minute. Render atomically claims a daily `reminderDeliveries/{reminderKey}` document, sends only unfinished delivery channels, and marks completion only after required channels succeed.

**Tech Stack:** Node.js CommonJS, Express, Firebase Admin/Firestore transactions, Firebase Cloud Messaging, Cloudflare Workers, Wrangler, Node test runner

---

## File Map

- Create `reminder_delivery.js`: pure reminder-key, authorization, channel-state, and completion decisions.
- Create `test/reminder_delivery.test.js`: unit coverage for authorization, daily keys, retries, buzzer-disabled completion, and expiry.
- Modify `server.js`: protected endpoint, Firestore claim lease, channel-specific retries, invalid FCM-token cleanup, and delivery summaries.
- Create `cloudflare-reminder-worker/src/index.mjs`: scheduled HTTP trigger with timeout and one retry.
- Create `cloudflare-reminder-worker/test/index.test.mjs`: Worker retry and secret-header tests.
- Create `cloudflare-reminder-worker/wrangler.toml`: Worker entry point and one-minute Cron schedule.
- Modify `package.json`: add a repeatable backend test command.

### Task 1: Reminder Delivery Decisions

**Files:**
- Create: `reminder_delivery.js`
- Create: `test/reminder_delivery.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing tests**

Test these exact behaviors:

```js
assert.equal(isCronAuthorized("same-secret", "same-secret"), true);
assert.equal(isCronAuthorized("wrong", "same-secret"), false);
assert.equal(buildReminderKey("med/1", "2026/06/12", "14:00"), "med_1_2026-06-12_14-00");
assert.deepEqual(requiredChannels({ buzzerEnabled: false }), {
  phone: true,
  medicineBox: false,
});
assert.equal(isDeliveryComplete({
  phoneNotificationSent: true,
  medicineBoxRequired: false,
  medicineBoxCommandQueued: false,
}), true);
assert.equal(isExpired({ nowMinutes: 851, medicineMinutes: 840 }), true);
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test test/reminder_delivery.test.js`

Expected: FAIL because `../reminder_delivery` does not exist.

- [ ] **Step 3: Implement the pure functions**

Export:

```js
module.exports = {
  buildReminderKey,
  isCronAuthorized,
  isDeliveryComplete,
  isExpired,
  requiredChannels,
  shouldAttemptMedicineBox,
  shouldAttemptPhone,
};
```

Use `crypto.timingSafeEqual` for equal-length secret comparison and sanitize `/`, whitespace, and `:` in reminder keys.

- [ ] **Step 4: Run all backend tests**

Run: `node --test test/*.test.js`

Expected: all tests pass.

- [ ] **Step 5: Add the npm test command and commit**

Set:

```json
"scripts": {
  "start": "node server.js",
  "test": "node --test test/*.test.js"
}
```

Commit: `Add reminder delivery state helpers`

### Task 2: Protected, Retryable Render Scheduler

**Files:**
- Modify: `server.js`
- Create: `test/reminder_scheduler.test.js`

- [ ] **Step 1: Write failing scheduler tests**

Extract and test dependency-injected `processReminder` behavior:

```js
await processReminder({
  delivery: { phoneNotificationSent: true, medicineBoxCommandQueued: false },
  medicineBoxRequired: true,
  sendPhone: failIfCalled,
  queueMedicineBox: async () => ({ queued: true, deviceId: "box-1" }),
});
```

Assert the phone channel is not repeated, the box channel is queued, and completion becomes true. Add cases for zero FCM successes, buzzer disabled, and a failed box queue.

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test test/reminder_scheduler.test.js`

Expected: FAIL because the scheduler module does not exist.

- [ ] **Step 3: Implement `reminder_scheduler.js`**

Create a dependency-injected channel processor that returns:

```js
{
  phoneNotificationSent,
  medicineBoxRequired,
  medicineBoxCommandQueued,
  completed,
  errors,
}
```

Treat FCM as successful only when `successCount > 0`. Treat `buzzer_disabled` as a non-required medicine-box channel.

- [ ] **Step 4: Integrate Firestore claims in `server.js`**

For each due medicine:

1. Build a daily reminder key.
2. Use `db.runTransaction` on `reminderDeliveries/{reminderKey}`.
3. Skip `completed`, `expired`, or an unexpired `processing` lease.
4. Claim with `processing`, a two-minute lease, and incremented attempts.
5. Run only unfinished channels through `processReminder`.
6. Write channel results and set `completed`, `pending`, or `expired`.
7. Mirror `reminderSent` on the medicine document only after delivery completes for backward compatibility.

- [ ] **Step 5: Protect the endpoint**

Replace the public GET route with:

```js
app.post("/internal/check-medicine-reminders", authenticateCron, async (req, res) => {
  return res.json(await checkMedicineReminders());
});
```

`authenticateCron` must return `503` when `CRON_SECRET` is missing and `401` for an invalid `x-cron-secret`.

- [ ] **Step 6: Remove invalid FCM tokens**

When Firebase reports `messaging/registration-token-not-registered` or `messaging/invalid-registration-token`, remove that token from every user document that owns it.

- [ ] **Step 7: Run all backend tests and commit**

Run: `npm test`

Expected: all tests pass.

Commit: `Make medicine reminders idempotent and retryable`

### Task 3: Cloudflare Cron Worker

**Files:**
- Create: `cloudflare-reminder-worker/src/index.mjs`
- Create: `cloudflare-reminder-worker/test/index.test.mjs`
- Create: `cloudflare-reminder-worker/wrangler.toml`

- [ ] **Step 1: Write failing Worker tests**

Test:

1. Sends `POST` to `${RENDER_BASE_URL}/internal/check-medicine-reminders`.
2. Sends `x-cron-secret`.
3. Retries once after a `500`.
4. Does not retry after a `401`.

- [ ] **Step 2: Run the Worker test and verify RED**

Run: `node --test cloudflare-reminder-worker/test/index.test.mjs`

Expected: FAIL because the Worker module does not exist.

- [ ] **Step 3: Implement the Worker**

Export `triggerReminderCheck(env, fetchImpl)` for tests and a default object with `scheduled(controller, env, ctx)`. Use an eight-second `AbortSignal.timeout`, retry once for network errors and `5xx`, and throw after the final failure so Cloudflare records it.

- [ ] **Step 4: Add Wrangler configuration**

Use:

```toml
name = "retrocare-reminder-scheduler"
main = "src/index.mjs"
compatibility_date = "2026-06-12"

[triggers]
crons = ["* * * * *"]
```

- [ ] **Step 5: Run all tests and commit**

Run:

```powershell
npm test
node --test cloudflare-reminder-worker/test/index.test.mjs
```

Expected: all tests pass.

Commit: `Add Cloudflare reminder cron worker`

### Task 4: Configure and Deploy

**Files:**
- No source changes unless deployment validation finds a defect.

- [ ] **Step 1: Generate a secret**

Generate 32 random bytes as a 64-character hexadecimal string. Do not write it to git or logs.

- [ ] **Step 2: Configure Render**

Set `CRON_SECRET` on the existing Render service without changing `FIREBASE_SERVICE_ACCOUNT` or `DEVICE_API_SECRET`.

- [ ] **Step 3: Push backend deployment**

Run:

```powershell
git push origin main
```

Expected: the Render Git deployment starts from the new `main` commit.

- [ ] **Step 4: Authenticate Wrangler**

Run: `npx wrangler whoami`

If unauthenticated, run `npx wrangler login` and complete the browser authorization.

- [ ] **Step 5: Configure Worker secrets and variables**

Run:

```powershell
$secret | npx wrangler secret put CRON_SECRET --config cloudflare-reminder-worker/wrangler.toml
npx wrangler deploy --config cloudflare-reminder-worker/wrangler.toml --var RENDER_BASE_URL:<render-url>
```

- [ ] **Step 6: Verify the deployed endpoint**

Call the Render endpoint once with an invalid secret and expect `401`, then once with the configured secret and expect `200` plus the reminder count summary.

- [ ] **Step 7: Verify Cloudflare deployment**

Inspect the Worker deployment and Cron trigger with Wrangler. Confirm the Cron expression is `* * * * *`.

### Task 5: End-to-End Verification

**Files:**
- No planned source changes.

- [ ] **Step 1: Run fresh automated verification**

Run:

```powershell
npm test
node --test cloudflare-reminder-worker/test/index.test.mjs
git diff --check HEAD~3..HEAD
```

- [ ] **Step 2: Confirm Render health**

Request the Render root endpoint and expect `RetroCare FCM Server is running`.

- [ ] **Step 3: Confirm scheduled execution**

Check Cloudflare Worker logs after at least one minute and confirm a successful `200` call.

- [ ] **Step 4: Report physical-device limitation**

Do not claim phone vibration or audible ESP32 buzzer verification unless a physical phone and medicine box are available during the test.
