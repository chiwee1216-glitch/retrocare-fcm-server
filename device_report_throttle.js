const DEFAULT_HEARTBEAT_MS = 15000;

function shouldPersistDeviceReport({
  lastPersistedAt = 0,
  now = Date.now(),
  eventCount = 0,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
}) {
  return (
    eventCount > 0 ||
    !Number.isFinite(lastPersistedAt) ||
    lastPersistedAt <= 0 ||
    now - lastPersistedAt >= heartbeatMs
  );
}

module.exports = {
  DEFAULT_HEARTBEAT_MS,
  shouldPersistDeviceReport,
};
