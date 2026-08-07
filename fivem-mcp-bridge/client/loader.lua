--[[
    The only script every client receives.

    It contains no tooling of its own -- it asks the server for the real client
    code, runs it with load(), and keeps a handle so the next reload can clean
    up after the previous one.

    The asking never stops until it succeeds. Every half of this system starts
    on its own schedule -- game client, FiveM server, MCP server -- and every
    combination has to end up connected, so nothing here may treat "no answer
    yet" or "refused right now" as final. On a player who is not on the
    developer list that amounts to one server event per minute, and the server
    logs the refusal once.
]]

local RESOURCE = GetCurrentResourceName()

--- Backoff for the payload request. There is deliberately NO attempt limit:
--- the request can be lost while the client is still joining, the server half
--- of this resource may not be registered yet, and the MCP server may only be
--- started later. A bounded loop turned any of those into a session that never
--- connects until someone typed /fivem_reload by hand.
local RETRY_MIN_MS = 3000
local RETRY_MAX_MS = 30000
--- After an explicit refusal the loop keeps going, but slowly: a developer who
--- is added to authorized.txt mid-session should not have to restart the game, and
--- an ordinary player must not turn into console noise on the server.
local RETRY_DENIED_MS = 60000
--- Granularity at which the waiting loop notices a refusal that arrived while
--- it was already sleeping.
local RETRY_SLICE_MS = 500
--- Floor between two token-refresh requests triggered by the NUI bridge.
local REAUTH_COOLDOWN_MS = 20000

--- The module table returned by the running payload, or nil.
local active = nil
--- Bumped to retire the current request loop; see startRequestLoop.
local requestGeneration = 0
--- Only true while a /fivem_reload is in flight, so a refusal can be reported.
local manualRequest = false
--- Generation whose request loop the server told to slow down. Compared against
--- requestGeneration, so a refusal that was still in flight when a new loop
--- started cannot put the new loop on the slow pace. It never ends a loop.
local deniedGeneration = 0
--- GetGameTimer() of the last bridgeReauth-triggered request.
local lastReauthAt = -REAUTH_COOLDOWN_MS
--- Floor between two /fivem_reload-triggered requests, so holding the key bound to
--- the command does not turn into client->server event spam.
local RELOAD_COOLDOWN_MS = 5000
local lastReloadAt = -RELOAD_COOLDOWN_MS

--- Forward declaration: the NUI callbacks below are registered before the loop
--- itself is defined, and bridgeReauth has to be able to call into it.
local startRequestLoop

local function report(fmt, ...)
    print(('[%s] ' .. fmt):format(RESOURCE, ...))
end

--- Lets the previous payload shut down its threads, NUI connection and handlers.
--- A broken dispose must never block the reload, hence the pcall.
local function disposeActive()
    local previous = active
    active = nil
    if type(previous) ~= 'table' or type(previous.dispose) ~= 'function' then
        return
    end

    local ok, err = pcall(previous.dispose)
    if not ok then
        report('the previous payload failed to dispose: %s', tostring(err))
    end
end

local function stopRequestLoop()
    requestGeneration = requestGeneration + 1
end

--[[
    NUI callbacks and commands are registered exactly once, here.

    RegisterNUICallback is built on AddEventHandler, and event handlers in FiveM
    *accumulate* -- they do not replace an earlier registration of the same name.
    Registering them inside the payload therefore left every previous handler
    alive after a reload, and the oldest one answered first. The payload only
    supplies functions; this file owns the wiring.
]]
local function handlerFor(name)
    if type(active) ~= 'table' or type(active.handlers) ~= 'table' then
        return nil
    end
    local fn = active.handlers[name]
    return type(fn) == 'function' and fn or nil
end

--- Dispatches a NUI callback to the active payload, or answers `fallback`.
--- The pcall matters: a handler that errors before calling cb would leave the
--- NUI fetch pending forever, and with it the MCP request it carries.
local function dispatch(name, data, cb, fallback)
    local fn = handlerFor(name)
    if not fn then
        cb(fallback)
        return
    end

    local ok, err = pcall(fn, data, cb)
    if not ok then
        report('handler %s failed: %s', name, tostring(err))
        -- If the handler already answered, this second cb is a no-op.
        cb({ ok = false, error = ('handler %s failed: %s'):format(name, tostring(err)) })
    end
end

RegisterNUICallback('fivemMcpBoot', function(data, cb)
    -- boot.js treats ready = false as "not ready yet" and keeps polling.
    dispatch('boot', data, cb, { ready = false })
end)

RegisterNUICallback('execCommand', function(data, cb)
    dispatch('execCommand', data, cb, { ok = false, error = 'no payload is active on this client' })
end)

RegisterNUICallback('evalCode', function(data, cb)
    dispatch('evalCode', data, cb, { ok = false, error = 'no payload is active on this client' })
end)

RegisterNUICallback('bridgeLog', function(data, cb)
    dispatch('bridgeLog', data, cb, { ok = true })
end)

--[[
    Raised by the NUI bridge when the MCP server refuses the handshake with
    4001 (bad token).

    Reconnecting cannot fix that: the token this client holds was baked into the
    payload when it was delivered, while the authoritative copy lives in
    bridge.token on the FiveM server. That copy changes whenever the MCP server
    generates a new one -- which is exactly what happens when the MCP server is
    (re)started after the payload was already handed out. Fetching the payload
    again is the only way to pick the new token up, and the server re-reads the
    file on every request.
]]
RegisterNUICallback('bridgeReauth', function(_, cb)
    cb({ ok = true })

    local now = GetGameTimer()
    if now - lastReauthAt < REAUTH_COOLDOWN_MS then
        return
    end
    lastReauthAt = now

    report('the bridge rejected our token, asking the server for a fresh payload')
    startRequestLoop()
end)

RegisterCommand('fivem_ping', function(...)
    local fn = handlerFor('ping')
    if fn then
        fn(...)
    end
end, false)

--[[
    Asks the server for the payload until it gets one.

    The loop only ends when a payload is delivered (or the resource stops), so
    the startup order of game client, FiveM server and MCP server does not
    matter. A refusal does not end it either -- it only slows it down to
    RETRY_DENIED_MS, which is what makes "add the identifier to authorized.txt and
    it works a minute later" possible without a rejoin.
]]
function startRequestLoop()
    requestGeneration = requestGeneration + 1
    local generation = requestGeneration
    -- Every caller (resource start, /fivem_reload, bridgeReauth) is a fresh reason
    -- to ask; a refusal aimed at an older generation does not slow this one.

    CreateThread(function()
        local delay = RETRY_MIN_MS

        while generation == requestGeneration do
            TriggerServerEvent('fivem-mcp:requestPayload')

            -- The answer arrives asynchronously, so sleep in slices: a refusal
            -- that lands mid-wait takes effect on this wait, not the next one.
            local waited = 0
            while generation == requestGeneration do
                local target = deniedGeneration == generation and RETRY_DENIED_MS or delay
                if waited >= target then
                    break
                end
                Wait(RETRY_SLICE_MS)
                waited = waited + RETRY_SLICE_MS
            end

            -- While denied, the pace is RETRY_DENIED_MS anyway; growing `delay`
            -- underneath would only make the first post-denial retry slow too.
            if deniedGeneration ~= generation then
                delay = math.min(math.floor(delay * 1.5), RETRY_MAX_MS)
            end
        end
    end)
end

RegisterNetEvent('fivem-mcp:deliverPayload')
AddEventHandler('fivem-mcp:deliverPayload', function(payload)
    -- Validate and compile BEFORE retiring the request loop or the running
    -- payload: a broken delivery must leave both intact, so the client keeps
    -- retrying and recovers on its own the moment the payload file is fixed.
    -- Killing the loop first turned one syntax error into a client that could
    -- only be revived by a manual /fivem_reload.
    if type(payload) ~= 'table' or type(payload.lua) ~= 'string' or payload.lua == '' then
        report('the server sent an unusable payload')
        return
    end

    -- The '@' chunk name puts a readable path into stack traces instead of
    -- [string "..."]. 't' refuses precompiled bytecode.
    local chunk, compileError = load(payload.lua, '@' .. RESOURCE .. '/payload/client.lua', 't')
    if not chunk then
        report('payload failed to compile: %s', tostring(compileError))
        return
    end

    stopRequestLoop()
    manualRequest = false

    disposeActive()

    -- Unconditionally, not only through the previous payload's dispose: the NUI
    -- page has its own lifetime and may already be sitting on an older bridge
    -- (or on none at all, if its very first poll raced the resource start).
    -- This is the signal that makes it drop what it has and poll again, so the
    -- Lua and NUI halves cannot end up on different payload revisions.
    SendNUIMessage({ type = 'fivem-mcp:dispose' })

    local ok, result = pcall(chunk, {
        resource = RESOURCE,
        -- Only the strings survive; anything else the chunk must treat as absent.
        url = type(payload.url) == 'string' and payload.url or nil,
        token = type(payload.token) == 'string' and payload.token or nil,
        js = type(payload.js) == 'string' and payload.js or nil,
    })

    if not ok then
        report('payload failed to run: %s', tostring(result))
        -- The previous payload is already gone, so start asking again: a fixed
        -- payload file then recovers this client without a manual /fivem_reload.
        startRequestLoop()
        return
    end

    if type(result) ~= 'table' then
        report('payload returned no module table -- the next reload cannot clean up after it')
        result = {}
    end

    active = result
end)

RegisterNetEvent('fivem-mcp:denied')
AddEventHandler('fivem-mcp:denied', function(reason)
    -- Not stopRequestLoop(): the refusal only drops the loop to RETRY_DENIED_MS.
    -- A refusal is not necessarily final -- identifiers and ACE permissions are
    -- not always resolved yet while a client is still joining, a developer can
    -- be added to the list at any time, and a missing bridge.token is refused
    -- here too so that starting the MCP server is all it takes to recover.
    deniedGeneration = requestGeneration

    -- Silent for ordinary players: being refused is the normal case and there
    -- is nothing for them to act on. The server console logs the first refusal.
    if manualRequest then
        manualRequest = false
        report(
            'the server refused the payload: %s',
            type(reason) == 'string' and reason ~= '' and reason or 'no reason given'
        )
    end
end)

--- Re-fetches the payload without restarting the resource. The server
--- re-authorizes on every request, so revoked access takes effect here.
RegisterCommand('fivem_reload', function()
    local now = GetGameTimer()
    if now - lastReloadAt < RELOAD_COOLDOWN_MS then
        return
    end
    lastReloadAt = now

    manualRequest = true
    startRequestLoop()
end, false)

AddEventHandler('onClientResourceStart', function(name)
    if name == RESOURCE then
        startRequestLoop()
    end
end)

AddEventHandler('onClientResourceStop', function(name)
    if name == RESOURCE then
        stopRequestLoop()
        disposeActive()
    end
end)
