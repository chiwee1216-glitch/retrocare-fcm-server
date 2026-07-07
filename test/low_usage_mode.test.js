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

test("device config reads use a short cache so app-written commands are timely", () => {
  assert.match(serverSource, /DEVICE_CONFIG_CACHE_TTL_MS\s*=\s*5\s*\*\s*1000/);
  assert.match(serverSource, /getCachedDeviceConfig/);
});

test("queued medicine-box commands invalidate the config cache", () => {
  assert.match(serverSource, /deviceConfigCache\.delete\(deviceDoc\.id\)/);
});

test("mobile medicine-box commands go through an authenticated cache-invalidating endpoint", () => {
  assert.match(
    serverSource,
    /app\.post\(\s*"\/device\/command",\s*authenticateFirebaseUser/
  );
  assert.match(serverSource, /queueMedicineBoxCommand\(patientId,\s*action\)/);
});

test("medicine box can still poll commands frequently for timely care actions", () => {
  assert.match(
    boxSource,
    /CLOUD_CONFIG_INTERVAL\s*=\s*10000/
  );
  assert.doesNotMatch(boxSource, /WiFi\.config\(/);
});

test("reminder check scans schedule rows instead of every unfinished medicine", () => {
  const start = serverSource.indexOf("async function checkMedicineReminders()");
  const end = serverSource.indexOf("async function checkDailyMedicineRefills", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const section = serverSource.slice(start, end);
  assert.match(section, /collection\("medicineSchedules"\)/);
  assert.match(section, /where\("date",\s*"==",\s*today\)/);
  assert.match(section, /where\("status",\s*"in",\s*\["scheduled",\s*"reminding"\]\)/);
  assert.doesNotMatch(section, /collection\("medicines"\)\s*[\s\S]{0,120}\.where\("isDone",\s*"==",\s*false\)/);
});

test("medicine box still reports hardware events quickly", () => {
  assert.match(
    boxSource,
    /CLOUD_EVENT_REPORT_INTERVAL\s*=\s*500/
  );
});
