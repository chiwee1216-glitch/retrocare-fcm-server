import test from "node:test";
import assert from "node:assert/strict";

import { triggerReminderCheck } from "../src/index.mjs";

const env = {
  RENDER_BASE_URL: "https://retrocare.example.com/",
  CRON_SECRET: "cron-secret",
};

test("posts to Render with the cron secret", async () => {
  const calls = [];
  const result = await triggerReminderCheck(env, async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://retrocare.example.com/internal/check-medicine-reminders"
  );
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["x-cron-secret"], "cron-secret");
  assert.equal(result.status, 200);
});

test("retries once after a server error", async () => {
  let attempts = 0;

  const result = await triggerReminderCheck(env, async () => {
    attempts++;
    return attempts === 1
      ? new Response("temporary failure", { status: 500 })
      : new Response(JSON.stringify({ success: true }), { status: 200 });
  });

  assert.equal(attempts, 2);
  assert.equal(result.status, 200);
});

test("does not retry an authentication error", async () => {
  let attempts = 0;

  await assert.rejects(
    triggerReminderCheck(env, async () => {
      attempts++;
      return new Response("unauthorized", { status: 401 });
    }),
    /status 401/
  );

  assert.equal(attempts, 1);
});
