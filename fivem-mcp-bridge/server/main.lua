--[[
    Gatekeeper for the fivem-mcp payload.

    Holds the only copy of the real client code and hands it out to authorized
    developers only. Nothing here ever trusts data coming from a client -- the
    request event carries no arguments and identity is taken from `source`.
]]

local RESOURCE = GetCurrentResourceName()

--[[
    Identifiers from authorized.txt in the resource root: one per line, blank
    lines and #-comments skipped.

    Re-read on every request for the same reason bridge.token is (see
    loadDeliverables): the file is gitignored, so real licenses never reach the
    repo, and an edit takes effect on the client's next request -- no resource
    restart. A missing file is simply an empty list.
]]
local function fileAuthorized()
    local lookup = {}
    local content = LoadResourceFile(RESOURCE, 'authorized.txt')
    if not content then
        return lookup
    end
    for line in content:gmatch('[^\r\n]+') do
        local id = line:match('^%s*(.-)%s*$')
        if id ~= '' and id:sub(1, 1) ~= '#' then
            lookup[id:lower()] = true
        end
    end
    return lookup
end

--- src -> GetGameTimer() of the last request, so nobody can spin the event.
local lastRequest = {}

--- src -> true once a refusal was logged. Clients retry indefinitely by design
--- (see client/loader.lua), so without this an unauthorized player would write
--- a line to the console every minute for the whole session.
local deniedLogged = {}

local function log(fmt, ...)
    print(('[%s] ' .. fmt):format(RESOURCE, ...))
end

local function warn(fmt, ...)
    print(('[%s] WARN: ' .. fmt):format(RESOURCE, ...))
end

--- Same, but at most once a minute. For conditions that every retrying client
--- runs into at the same time -- one console line per player and minute is
--- noise, one line per minute is the diagnosis.
local WARN_THROTTLE_MS = 60000
local lastWarnAt = {}

local function warnThrottled(fmt, ...)
    local now = GetGameTimer()
    local previous = lastWarnAt[fmt]
    if previous and now - previous < WARN_THROTTLE_MS then
        return
    end
    lastWarnAt[fmt] = now
    warn(fmt, ...)
end

--- Readable identity for the log, so a denied developer knows what to put in authorized.txt.
local function describe(src)
    local name = GetPlayerName(src) or 'unknown'
    local license = 'no-license'
    for _, identifier in ipairs(GetPlayerIdentifiers(src) or {}) do
        if identifier:sub(1, 8) == 'license:' then
            license = identifier
            break
        end
    end
    return ('%s [%s] (id %s)'):format(name, license, tostring(src))
end

--- Either path is enough: a line in authorized.txt, or the ACE object.
local function isAuthorized(src)
    local fromFile = fileAuthorized()
    for _, identifier in ipairs(GetPlayerIdentifiers(src) or {}) do
        if fromFile[identifier:lower()] then
            return true, 'authorized.txt'
        end
    end

    local ace = Config.aceObject
    if type(ace) == 'string' and ace ~= '' and IsPlayerAceAllowed(src, ace) then
        return true, ('ace "%s"'):format(ace)
    end

    return false
end

--- Reads a file that clients never receive. Returns nil for missing or empty.
local function readResourceFile(path)
    local content = LoadResourceFile(RESOURCE, path)
    if not content or content == '' then
        return nil
    end
    return content
end

--[[
    Gathers everything a delivery needs: the current token and both payload
    files. Returns a table, or nil plus the refusal reason.

    Everything is re-read here rather than cached at start. bridge.token in
    particular changes whenever the MCP server generates a new one, and a client
    that asks again (see the bridgeReauth path in client/loader.lua) has to get
    the current one, not the one that was on disk when this resource started.
    Re-reading the payload files is what lets /fivem_reload pick up edits without
    a resource restart.
]]
local function loadDeliverables(src)
    --[[
        The token comes first: it is the most common thing to be missing, and a
        payload without a token is worse than no payload -- the NUI bridge would
        come up, be refused by the MCP server and have nothing to fall back on.
        Refusing instead keeps the client in its retry loop, so simply starting
        the MCP server (which writes the file) is enough to get it connected --
        no resource restart, no /fivem_reload.
    ]]
    local token = readResourceFile('bridge.token')
    if token then
        token = token:match('^%s*(.-)%s*$')
    end
    if not token or token == '' then
        warnThrottled(
            'bridge.token is missing or empty, refusing to serve a payload. Point "tokenFile" in '
                .. 'mcp-server/fivem-mcp.config.json at %s/bridge.token and start the MCP server; '
                .. 'clients pick the token up by themselves once the file exists.',
            RESOURCE
        )
        return nil, 'bridge.token is missing on the server -- is the MCP server running?'
    end

    local lua = readResourceFile('payload/client.lua')
    if not lua then
        warn('payload/client.lua is missing or empty, cannot serve %s', describe(src))
        return nil, 'payload/client.lua is missing on the server'
    end

    local js = readResourceFile('payload/nui.js')
    if not js then
        warn('payload/nui.js is missing or empty, cannot serve %s', describe(src))
        return nil, 'payload/nui.js is missing on the server'
    end

    return { lua = lua, js = js, token = token }
end

--[[
    Authorizes `src` and hands the payload over, or refuses.

    `trigger` is only there for the log. `announceRefusal` is false for the
    unsolicited push below: a client that never asked must not be told "no",
    because that would slow its own request loop down before it ever ran.
]]
local function servePayload(src, trigger, announceRefusal)
    --- Tells the client to slow down and try again later. The reason only
    --- surfaces on a manual /fivem_reload, where somebody is watching the console.
    local function refuse(reason)
        if announceRefusal then
            TriggerClientEvent('fivem-mcp:denied', src, reason)
        end
    end

    local allowed, grant = isAuthorized(src)
    if not allowed then
        -- Only a refusal the client actually waits for is worth a line, and
        -- only the first one: clients retry for the whole session, and the
        -- unsolicited push below would otherwise print one line per player.
        if announceRefusal and not deniedLogged[src] then
            deniedLogged[src] = true
            log('denied payload to %s (%s)', describe(src), trigger)
        end
        refuse('not authorized -- check authorized.txt or your ACE permission')
        return
    end
    deniedLogged[src] = nil

    local delivery, reason = loadDeliverables(src)
    if not delivery then
        refuse(reason)
        return
    end

    log('granted payload to %s via %s (%s)', describe(src), grant, trigger)

    -- Also on the push path, so a client request that was already in flight when
    -- this delivery went out does not immediately trigger a second one.
    lastRequest[src] = GetGameTimer()

    TriggerClientEvent('fivem-mcp:deliverPayload', src, {
        lua = delivery.lua,
        js = delivery.js,
        token = delivery.token,
        url = Config.bridgeUrl,
    })
end

RegisterNetEvent('fivem-mcp:requestPayload')
AddEventHandler('fivem-mcp:requestPayload', function()
    local src = source
    if not src or src == 0 then
        return
    end

    local now = GetGameTimer()
    local previous = lastRequest[src]
    if previous and now - previous < (Config.requestCooldownMs or 2000) then
        return
    end
    lastRequest[src] = now

    servePayload(src, 'request', true)
end)

AddEventHandler('playerDropped', function()
    lastRequest[source] = nil
    deniedLogged[source] = nil
end)

AddEventHandler('onResourceStart', function(name)
    if name ~= RESOURCE then
        return
    end

    local fileCount = 0
    for _ in pairs(fileAuthorized()) do
        fileCount = fileCount + 1
    end

    local ace = Config.aceObject
    local aceEnabled = type(ace) == 'string' and ace ~= ''

    if fileCount == 0 and not aceEnabled then
        warn(
            'No authorized identifiers and no ACE object configured -- nobody will get the '
                .. 'payload. Put your license: identifier into %s/authorized.txt (one per line); '
                .. 'it is picked up without a restart.',
            RESOURCE
        )
        return
    end

    if fileCount == 0 then
        -- The ACE object being set does not mean anyone holds it; on a fresh
        -- install this is the state, and the payload goes to nobody.
        warn(
            'No identifiers in %s/authorized.txt. The payload is only granted '
                .. 'via ACE "%s" -- if you have not run `add_ace group.admin %s allow` (or put '
                .. 'your license: identifier into authorized.txt), nobody will get it.',
            RESOURCE,
            ace,
            ace
        )
    end

    log(
        'ready: %d identifier(s) in authorized.txt, ace object %s',
        fileCount,
        aceEnabled and ('"' .. ace .. '"') or 'disabled'
    )

    --[[
        Push to everyone who is already in the session.

        A client that restarts with this resource fires its request from
        onClientResourceStart, and that request can easily arrive before this
        script has registered the net event -- the two halves start
        independently. The client would then wait out its backoff for nothing.
        Pushing from here closes that race from the other side; a client whose
        resource has not started yet simply drops the event and asks for itself.

        Unauthorized players are passed over silently: they never asked, and a
        refusal would only put their own request loop on the slow interval.
    ]]
    CreateThread(function()
        Wait(1000)
        for _, id in ipairs(GetPlayers()) do
            local src = tonumber(id)
            if src then
                servePayload(src, 'resource start', false)
            end
        end
    end)
end)
