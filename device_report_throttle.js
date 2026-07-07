const DEFAULT_HEARTBEAT_MS = 5 * 60 * 1000;

function shouldPersistDeviceReport({
  lastPersistedAt = 0,
  now = Date.now(),
  eventCount = 0,
  hasCommandAck = false,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
}) {
  return (
    eventCount > 0 ||
    hasCommandAck ||
    !Number.isFinite(lastPersistedAt) ||
    lastPersistedAt <= 0 ||
    now - lastPersistedAt >= heartbeatMs
  );
}

module.exports = {
  DEFAULT_HEARTBEAT_MS,
  shouldPersistDeviceReport,
};
