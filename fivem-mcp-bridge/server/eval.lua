--[[
    Loopback-only HTTP eval handler behind fivem_server_run_code.

    Registered ONLY when Config.serverEval is true -- with the flag off (the
    shipped default) this file returns before SetHttpHandler is ever called and
    the endpoint plain does not exist.

    Contract: POST /<resource>/eval on the FXServer game port, loopback peers
    only, with the bridge token in the X-Fivem-Mcp-Token header. The token is
    re-read from bridge.token on every request, like server/main.lua does, so a
    rotated token applies immediately. The body is JSON { code = "..." }; the
    snippet is compiled with load(..., 't') -- source only, never bytecode --
    and called with a ctx table ({ resource, log }).

    This runs in THIS resource's server Lua state: other resources' globals are
    not visible; reach them via exports, events or console commands.
]]

local RESOURCE = GetCurrentResourceName()

if Config.serverEval ~= true then
    return
end

local function log(fmt, ...)
    print(('[%s] ' .. fmt):format(RESOURCE, ...))
end

local LOOPBACK = { ['127.0.0.1'] = true, ['::1'] = true, ['::ffff:127.0.0.1'] = true }

--- request.address may carry a port depending on the build; accept both shapes.
local function isLoopback(address)
    local a = tostring(address or '')
    if LOOPBACK[a] then
        return true
    end
    local bracket = a:match('^%[(.-)%]:%d+$')
    if bracket and LOOPBACK[bracket] then
        return true
    end
    local host = a:match('^(.*):%d+$')
    if host and LOOPBACK[host] then
        return true
    end
    return false
end

--- Constant-time comparison: the loop always walks the longer string and never
--- returns early, so timing leaks nothing about how much of a guess matched.
local function tokenMatches(supplied, expected)
    if type(supplied) ~= 'string' or type(expected) ~= 'string' or expected == '' then
        return false
    end
    local mismatch = (#supplied == #expected) and 0 or 1
    for i = 1, math.max(#supplied, #expected) do
        local a = supplied:byte(i) or -1
        local b = expected:byte(i) or -2
        if a ~= b then
            mismatch = mismatch + 1
        end
    end
    return mismatch == 0
end

--- Header names arrive as the client sent them; compare case-insensitively.
local function headerToken(headers)
    if type(headers) ~= 'table' then
        return nil
    end
    for name, value in pairs(headers) do
        if type(name) == 'string' and name:lower() == 'x-fivem-mcp-token' then
            return value
        end
    end
    return nil
end

--- Same budget as the client payload: a snippet that never yields would hang
--- the server's script runtime outright.
local INSTRUCTION_LIMIT = 200000000

SetHttpHandler(function(req, res)
    local function answer(code, body)
        res.writeHead(code, { ['Content-Type'] = 'application/json' })
        res.send(json.encode(body))
    end

    if req.path ~= '/eval' or req.method ~= 'POST' then
        answer(404, { ok = false, error = 'not found' })
        return
    end
    if not isLoopback(req.address) then
        log('refused /eval from non-loopback address %s', tostring(req.address))
        answer(403, { ok = false, error = 'loopback only' })
        return
    end

    local expected = LoadResourceFile(RESOURCE, 'bridge.token')
    expected = expected and expected:match('^%s*(.-)%s*$') or ''
    if not tokenMatches(headerToken(req.headers), expected) then
        answer(401, { ok = false, error = 'bad or missing token' })
        return
    end

    req.setDataHandler(function(body)
        local okDecode, decoded = pcall(json.decode, body)
        local code = okDecode and type(decoded) == 'table' and decoded.code or nil
        if type(code) ~= 'string' or code:match('^%s*$') then
            answer(400, { ok = false, error = 'no code supplied' })
            return
        end

        -- 't' refuses precompiled bytecode; the '@' chunk name keeps stack
        -- traces readable instead of dumping the whole snippet into them.
        local chunk, compileError = load(code, '@' .. RESOURCE .. '/server-snippet', 't')
        if not chunk then
            answer(200, { ok = false, error = ('compile error: %s'):format(tostring(compileError)) })
            return
        end

        -- A thread of its own, so the snippet may Wait(); the response object
        -- stays usable until send is called.
        CreateThread(function()
            local logs = {}
            local ctx = {
                resource = RESOURCE,
                --- Prints with the resource prefix AND collects the line into
                --- the HTTP answer, so the caller needs no console round trip.
                log = function(fmt, ...)
                    local line
                    if select('#', ...) > 0 then
                        local okFmt, formatted = pcall(string.format, tostring(fmt), ...)
                        line = okFmt and formatted or tostring(fmt)
                    else
                        line = tostring(fmt)
                    end
                    logs[#logs + 1] = line
                    print(('[%s] %s'):format(RESOURCE, line))
                end,
            }

            local guarded = type(debug) == 'table' and type(debug.sethook) == 'function'
            if guarded then
                debug.sethook(function()
                    error(('snippet exceeded %d instructions without yielding -- aborted'):format(INSTRUCTION_LIMIT), 2)
                end, '', INSTRUCTION_LIMIT)
            end

            local startedAt = GetGameTimer()
            local returned = table.pack(pcall(chunk, ctx))

            if guarded then
                debug.sethook()
            end
            local durationMs = GetGameTimer() - startedAt

            if not returned[1] then
                answer(200, {
                    ok = false,
                    error = ('runtime error after %d ms: %s'):format(durationMs, tostring(returned[2])),
                    logs = #logs > 0 and logs or nil,
                })
                return
            end

            local values = {}
            for i = 2, returned.n do
                -- A hole would shift everything after it, so nil becomes a marker.
                local value = returned[i]
                values[i - 1] = value == nil and '<nil>' or AgentMarshal.sanitize(value, AgentMarshal.MAX_DEPTH, {})
            end

            answer(200, {
                ok = true,
                data = {
                    durationMs = durationMs,
                    -- An empty Lua table would encode as {} rather than [], so
                    -- a snippet with no return values omits the field entirely.
                    returned = returned.n > 1 and values or nil,
                    logs = #logs > 0 and logs or nil,
                },
            })
        end)
    end)
end)

log('server eval handler is ON (Config.serverEval = true): POST /eval, loopback only, token required')
