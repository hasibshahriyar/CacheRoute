-- KEYS[1]: cr:rl:{keyId}
-- ARGV[1]: capacity (burst, e.g. 20)
-- ARGV[2]: refill_per_sec (rpm / 60, e.g. 1.0)
-- ARGV[3]: cost (1)
-- ARGV[4]: now_sec

local b = redis.call("HMGET", KEYS[1], "tokens", "last_ts")
local tokens = tonumber(b[1])
local last_ts = tonumber(b[2])
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now_sec = tonumber(ARGV[4])

if tokens == nil or last_ts == nil then
  tokens = capacity
  last_ts = now_sec
else
  local elapsed = math.max(0, now_sec - last_ts)
  tokens = math.min(capacity, tokens + elapsed * refill)
  last_ts = now_sec
end

local allowed = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
end

redis.call("HSET", KEYS[1], "tokens", tostring(tokens), "last_ts", tostring(last_ts))
local ttl = math.max(60, math.ceil(capacity / math.max(0.001, refill)) * 2)
redis.call("EXPIRE", KEYS[1], ttl)

return { allowed, tostring(tokens) }
