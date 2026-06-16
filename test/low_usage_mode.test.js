const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const serverSource = fs.readFileSync(
  path.join(__dirname, "..", "server.js"),
  "utf8"
);

const boxSource = fs.readFileSync(
  path.join(__dirname, "..", "..", "..", "..", "藥盒", "box", "box.ino"),
  "utf8"
);

test("Render server does not run a local 30-second reminder scan loop", () => {
  assert.equal(
    /setInterval\s*\(\s*\(\)\s*=>\s*\{\s*triggerReminderCheck\(\);\s*\}\s*,\s*30000\s*\)/.test(
      serverSource
    ),
    false
  );
});

test("device config reads are protected by a one-minute Firestore cache", () => {
  assert.match(serverSource, /DEVICE_CONFIG_CACHE_TTL_MS\s*=\s*60\s*\*\s*1000/);
  assert.match(serverSource, /getCachedDeviceConfig/);
});

test("queued medicine-box commands invalidate the config cache", () => {
  assert.match(serverSource, /deviceConfigCache\.delete\(deviceDoc\.id\)/);
});

test("medicine box can still poll commands frequently for timely care actions", () => {
  assert.match(
    boxSource,
    /CLOUD_CONFIG_INTERVAL\s*=\s*5000/
  );
});

test("medicine box still reports hardware events quickly", () => {
  assert.match(
    boxSource,
    /CLOUD_EVENT_REPORT_INTERVAL\s*=\s*500/
  );
});
