-- KEYS[1]: cr:cb:{provider}
-- KEYS[2]: cr:cb:{provider}:probe
-- ARGV[1]: action ("can_execute" | "record_success" | "record_failure" | "get_state")
-- ARGV[2]: now_ms
-- ARGV[3]: retry_after_ms (0 if none)

local action = ARGV[1]
local now_ms = tonumber(ARGV[2])
local retry_after_ms = tonumber(ARGV[3]) or 0

local fields = redis.call("HMGET", KEYS[1], "state", "open_until_ms", "consecutive_failures", "backoff_level", "win")
local state = fields[1] or "CLOSED"
local open_until_ms = tonumber(fields[2]) or 0
local consecutive_failures = tonumber(fields[3]) or 0
local backoff_level = tonumber(fields[4]) or 0
local win_str = fields[5] or ""

local function prune_and_append(raw, cutoff_ms, new_entry)
  local kept = {}
  local total = 0
  local fails = 0
  for item in string.gmatch(raw, "([^,]+)") do
    local sep = string.find(item, ":")
    if sep then
      local ts = tonumber(string.sub(item, 1, sep - 1))
      local ok = tonumber(string.sub(item, sep + 1))
      if ts and ts >= cutoff_ms then
        table.insert(kept, item)
        total = total + 1
        if ok == 0 then
          fails = fails + 1
        end
      end
    end
  end
  if new_entry ~= nil then
    table.insert(kept, new_entry)
    total = total + 1
    local sep = string.find(new_entry, ":")
    if sep and tonumber(string.sub(new_entry, sep + 1)) == 0 then
      fails = fails + 1
    end
  end
  return table.concat(kept, ","), total, fails
end

if action == "get_state" then
  return { 1, state, tostring(open_until_ms) }
end

if action == "can_execute" then
  if state == "CLOSED" then
    return { 1, "CLOSED", "0" }
  elseif state == "OPEN" then
    if now_ms < open_until_ms then
      return { 0, "OPEN", tostring(open_until_ms) }
    end
    local locked = redis.call("SET", KEYS[2], "1", "NX", "EX", 10)
    if locked then
      redis.call("HSET", KEYS[1], "state", "HALF_OPEN")
      return { 1, "HALF_OPEN", tostring(open_until_ms) }
    end
    return { 0, "OPEN", tostring(open_until_ms) }
  elseif state == "HALF_OPEN" then
    local lock_exists = redis.call("EXISTS", KEYS[2])
    if lock_exists == 0 then
      local locked = redis.call("SET", KEYS[2], "1", "NX", "EX", 10)
      if locked then
        return { 1, "HALF_OPEN", tostring(open_until_ms) }
      end
    end
    return { 0, "HALF_OPEN", tostring(open_until_ms) }
  end
  return { 1, "CLOSED", "0" }
end

if action == "record_success" then
  local updated_win = prune_and_append(win_str, now_ms - 30000, tostring(now_ms) .. ":1")
  redis.call("HSET", KEYS[1],
    "state", "CLOSED",
    "open_until_ms", "0",
    "consecutive_failures", "0",
    "backoff_level", "0",
    "win", updated_win
  )
  redis.call("DEL", KEYS[2])
  return { 1, "CLOSED", "0" }
end

if action == "record_failure" then
  consecutive_failures = consecutive_failures + 1
  local updated_win, total, fails = prune_and_append(win_str, now_ms - 30000, tostring(now_ms) .. ":0")
  local window_trip = (total >= 10) and ((fails / total) >= 0.5)
  local consec_trip = consecutive_failures >= 5
  local probe_trip = (state == "HALF_OPEN")

  if probe_trip or consec_trip or window_trip then
    local base_cooldown = 30000 * (2 ^ backoff_level)
    local cooldown_ms = math.min(300000, math.max(base_cooldown, retry_after_ms))
    open_until_ms = now_ms + cooldown_ms
    backoff_level = math.min(10, backoff_level + 1)
    state = "OPEN"
    redis.call("DEL", KEYS[2])
  end

  redis.call("HSET", KEYS[1],
    "state", state,
    "open_until_ms", tostring(open_until_ms),
    "consecutive_failures", tostring(consecutive_failures),
    "backoff_level", tostring(backoff_level),
    "win", updated_win
  )
  return { 1, state, tostring(open_until_ms) }
end

return { 0, state, tostring(open_until_ms) }
