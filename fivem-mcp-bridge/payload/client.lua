--[[
    The real client code. Never shipped with the resource -- the server reads
    this file and sends it to authorized developers, where client/loader.lua
    runs it via load().

    Receives its context as chunk arguments and returns a module table:

        handlers  functions the loader dispatches NUI callbacks and commands to
        dispose   tears this instance down before the next one loads

    This file must NOT call RegisterNUICallback or RegisterCommand itself.
    Those registrations accumulate in FiveM and would survive every reload, with
    the oldest handler answering first. The loader owns them; the payload only
    supplies the functions behind them.

    Anything long-lived (threads, timers) must check the `alive` upvalue below.
    Each load() gets its own.
]]

local ctx = ...

local RESOURCE = ctx.resource or GetCurrentResourceName()
--- No fallback URL: the server always supplies Config.bridgeUrl, and a silent
--- default would only mask a delivery bug. An empty value is reported below.
local BRIDGE_URL = type(ctx.url) == 'string' and ctx.url or ''
local TOKEN = ctx.token or ''
local NUI_CODE = ctx.js or ''

--- Bumped by hand on every change, so a tool response proves which revision
--- actually ran after a /fivem_reload.
local PAYLOAD_REVISION = 8

--- Set to false by dispose(). Guards any thread this payload starts.
local alive = true

local function report(fmt, ...)
    print(('[%s] ' .. fmt):format(RESOURCE, ...))
end

if TOKEN == '' then
    report('the server delivered an empty token -- the bridge handshake will be refused')
end
if BRIDGE_URL == '' then
    report('the server delivered no bridge URL -- the NUI bridge cannot connect')
end

--- Looks a command up in this client's console registry. Returns nil when the
--- native is unavailable, which is not the same as "the command does not exist".
local function inspectCommand(verb)
    local ok, commands = pcall(GetRegisteredCommands)
    if not ok or type(commands) ~= 'table' then
        return nil
    end

    local wanted = verb:lower()
    for _, entry in ipairs(commands) do
        local name = type(entry) == 'table' and entry.name or entry
        if type(name) == 'string' and name:lower() == wanted then
            return true
        end
    end
    return false
end

local handlers = {}

--- The NUI page polls this until it answers, which is why there is no timing
--- race: before a payload is active the loader replies ready = false.
function handlers.boot(_, cb)
    cb({
        ready = true,
        code = NUI_CODE,
        config = {
            url = BRIDGE_URL,
            token = TOKEN,
            resource = RESOURCE,
        },
    })
end

--- Runs a console command in this client, exactly like typing it into F8.
function handlers.execCommand(data, cb)
    local command = data and data.command
    if type(command) ~= 'string' or command == '' then
        cb({ ok = false, error = 'no command supplied' })
        return
    end

    local verb = command:match('^(%S+)') or command
    local registered = inspectCommand(verb)

    local ok, err = pcall(ExecuteCommand, command)
    if not ok then
        cb({ ok = false, error = tostring(err) })
        return
    end

    -- ExecuteCommand returns nothing, so this stays an acknowledgement. The
    -- registry lookup is what tells a working command apart from a name that
    -- does not exist in this client's console context.
    cb({
        ok = true,
        data = {
            executed = command,
            payloadRevision = PAYLOAD_REVISION,
            -- Lua nil would simply vanish from the JSON, so "the registry
            -- native is unavailable" travels as an explicit sentinel instead
            -- of being indistinguishable from a missing key.
            registered = registered == nil and 'unknown' or registered,
        },
    })
end

--[[
    Running arbitrary snippets.

    This is the counterpart of fivem_run_code and the reason the payload is
    server-gated: it is a full Lua eval in the client's script context. The
    snippet is compiled with mode 't' (source only, never bytecode) and called
    with the context table below.
]]

--[[
    The value walk lives in shared/marshal.lua (loaded via shared_scripts, so
    it is present in this client Lua state) and is shared with the server eval
    handler. A client whose cached manifest predates that file would see nil
    here; the fallback keeps eval usable and the report says what to run.
]]
local marshal = AgentMarshal
if type(marshal) ~= 'table' then
    report('shared/marshal.lua is not loaded -- run "refresh" then "restart" on the resource. Return values are degraded to strings until then.')
    marshal = {
        MAX_DEPTH = 1,
        sanitize = function(value)
            return type(value) == 'table' and '<table: marshal unavailable>' or tostring(value)
        end,
    }
end

--- What a snippet gets as its single argument. Deliberately small: the point of
--- this tool is the native API, not a framework of our own.
local snippetContext = {
    resource = RESOURCE,

    --- False once this payload was disposed. Long loops must poll it, otherwise
    --- a /fivem_reload leaves them running with nothing to stop them.
    alive = function()
        return alive
    end,

    --- CreateThread for snippets: refuses to start after a dispose, and reports
    --- its own failures instead of dying silently inside the scheduler.
    thread = function(fn)
        if type(fn) ~= 'function' then
            error('ctx.thread expects a function', 2)
        end
        if not alive then
            return false
        end
        CreateThread(function()
            local ok, err = pcall(fn)
            if not ok then
                report('snippet thread failed: %s', tostring(err))
            end
        end)
        return true
    end,

    --- Prints with the resource prefix, so the line is easy to filter out of the
    --- client log afterwards.
    log = function(fmt, ...)
        if select('#', ...) > 0 then
            local ok, formatted = pcall(string.format, tostring(fmt), ...)
            report('%s', ok and formatted or tostring(fmt))
        else
            report('%s', tostring(fmt))
        end
    end,
}

--- The snippet runs synchronously on the client's script thread, so a snippet
--- that never yields (`while true do end`) would freeze the game outright. The
--- instruction-count hook turns that into a runtime error instead. The limit is
--- far beyond anything a legitimate synchronous snippet does before yielding.
local SNIPPET_INSTRUCTION_LIMIT = 200000000

--- Runs `chunk` under the instruction budget. debug.sethook only affects the
--- current coroutine, so threads a snippet starts via ctx.thread (which Wait)
--- are not throttled by this. If the debug library is unavailable the snippet
--- simply runs unguarded, which is no worse than before.
local function runGuarded(chunk)
    local guarded = type(debug) == 'table' and type(debug.sethook) == 'function'
    if guarded then
        debug.sethook(function()
            error(('snippet exceeded %d instructions without yielding -- aborted to keep the game responsive'):format(
                SNIPPET_INSTRUCTION_LIMIT
            ), 2)
        end, '', SNIPPET_INSTRUCTION_LIMIT)
    end

    local returned = table.pack(pcall(chunk, snippetContext))

    if guarded then
        debug.sethook()
    end
    return returned
end

--- Compiles and runs a Lua snippet in this client's context.
function handlers.evalCode(data, cb)
    local code = data and data.code
    if type(code) ~= 'string' or code:match('^%s*$') then
        cb({ ok = false, error = 'no code supplied' })
        return
    end

    -- 't' refuses precompiled bytecode; the '@' chunk name keeps stack traces
    -- readable instead of dumping the whole snippet into them.
    local chunk, compileError = load(code, '@' .. RESOURCE .. '/snippet', 't')
    if not chunk then
        cb({ ok = false, error = ('compile error: %s'):format(tostring(compileError)) })
        return
    end

    local startedAt = GetGameTimer()
    local returned = runGuarded(chunk)
    local durationMs = GetGameTimer() - startedAt

    if not returned[1] then
        cb({
            ok = false,
            error = ('runtime error after %d ms: %s'):format(durationMs, tostring(returned[2])),
        })
        return
    end

    local values = {}
    for i = 2, returned.n do
        -- A hole would shift everything after it, so nil becomes a marker.
        local value = returned[i]
        values[i - 1] = value == nil and '<nil>' or marshal.sanitize(value, marshal.MAX_DEPTH, {})
    end

    cb({
        ok = true,
        data = {
            payloadRevision = PAYLOAD_REVISION,
            durationMs = durationMs,
            -- An empty Lua table would encode as {} rather than [], so a
            -- snippet with no return values omits the field entirely.
            returned = returned.n > 1 and values or nil,
        },
    })
end

--- Lets the NUI side surface connection problems in the game console.
function handlers.bridgeLog(data, cb)
    report('%s', tostring(data and data.message or ''))
    cb({ ok = true })
end

--- Something harmless to aim the first fivem_execute_command call at.
function handlers.ping()
    report('pong (payload revision %d)', PAYLOAD_REVISION)
end

report('payload revision %d active, bridge target %s', PAYLOAD_REVISION, BRIDGE_URL)

return {
    handlers = handlers,
    -- The loader sends the NUI dispose message itself, unconditionally, so the
    -- teardown here is only the Lua side: stop threads via the alive flag.
    dispose = function()
        alive = false
    end,
}
