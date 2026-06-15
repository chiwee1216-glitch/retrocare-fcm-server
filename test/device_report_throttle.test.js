const test = require("node:test");
const assert = require("node:assert/strict");

const {
  shouldPersistDeviceReport,
} = require("../device_report_throttle");

test("throttles unchanged heartbeat reports inside five minutes", () => {
  assert.equal(
    shouldPersistDeviceReport({
      lastPersistedAt: 1000,
      now: 300999,
      eventCount: 0,
    }),
    false
  );
});

test("persists a heartbeat after five minutes", () => {
  assert.equal(
    shouldPersistDeviceReport({
      lastPersistedAt: 1000,
      now: 301000,
      eventCount: 0,
    }),
    true
  );
});

test("persists hardware events immediately", () => {
  assert.equal(
    shouldPersistDeviceReport({
      lastPersistedAt: 1000,
      now: 1200,
      eventCount: 1,
    }),
    true
  );
});
