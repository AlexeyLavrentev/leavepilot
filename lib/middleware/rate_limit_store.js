'use strict';

const LUA_CONSUME = [
  "local count = redis.call('INCR', KEYS[1])",
  "local ttl = redis.call('PTTL', KEYS[1])",
  "if count == 1 or ttl < 0 then",
  "  redis.call('PEXPIRE', KEYS[1], ARGV[1])",
  "  ttl = tonumber(ARGV[1])",
  'end',
  'return {count, ttl}',
].join('\n');

const memoryState = new Map();
let lastSweepAt = 0;

const consumeMemory = ({key, windowMs, now}) => {
  const timestamp = typeof now === 'number' ? now : Date.now();

  const sweepIntervalMs = Math.min(windowMs, 60 * 1000);
  if (timestamp - lastSweepAt >= sweepIntervalMs) {
    for (const [storedKey, storedEntry] of memoryState) {
      if (storedEntry.resetAt <= timestamp) {memoryState.delete(storedKey);}
    }
    lastSweepAt = timestamp;
  }

  let entry = memoryState.get(key);
  if (!entry) {
    entry = {count: 0, resetAt: timestamp + windowMs};
  }
  entry.count += 1;
  memoryState.set(key, entry);

  return {
    count: entry.count,
    retryAfterMs: Math.max(1, entry.resetAt - timestamp),
    distributed: false,
  };
};

const consume = async ({key, windowMs, redisClient, now}) => {
  if (redisClient && redisClient.isReady && typeof redisClient.eval === 'function') {
    try {
      const result = await redisClient.eval(LUA_CONSUME, {
        keys: ['leavepilot:rate-limit:' + key],
        arguments: [String(windowMs)],
      });
      return {
        count: Number(result[0]),
        retryAfterMs: Math.max(1, Number(result[1])),
        distributed: true,
      };
    } catch {
      // Availability wins over a login outage. Memory fallback still limits
      // this process until Redis recovers.
    }
  }

  return consumeMemory({key, windowMs, now});
};

const reset = () => {
  memoryState.clear();
  lastSweepAt = 0;
};

module.exports = {
  LUA_CONSUME,
  consume,
  consumeMemory,
  reset,
};
