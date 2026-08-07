-- ffa-arena :: server
-- Authoritative side: who is in the arena, which spawn they get, and every kill/death.
-- Clients only report *that* they died and who they think killed them; the server decides
-- whether that report counts.

local RES = GetCurrentResourceName()

-- [serverId] = { name, kills, deaths, lastDeathAt }
local participants = {}
local roundActive = true

local function log(fmt, ...)
    print(('[ffa-arena] ' .. fmt):format(...))
end

local function countParticipants()
    local n = 0
    for _ in pairs(participants) do n = n + 1 end
    return n
end

local function scoreboard()
    local rows = {}
    for id, p in pairs(participants) do
        rows[#rows + 1] = { id = id, name = p.name, kills = p.kills, deaths = p.deaths }
    end
    table.sort(rows, function(a, b)
        if a.kills ~= b.kills then return a.kills > b.kills end
        if a.deaths ~= b.deaths then return a.deaths < b.deaths end
        return a.name < b.name
    end)
    while #rows > Config.ScoreboardRows do
        rows[#rows] = nil
    end
    return rows
end

local function broadcastScores()
    local rows = scoreboard()
    for id in pairs(participants) do
        TriggerClientEvent('ffa-arena:scores', id, rows)
    end
end

-- Random, but never right next to somebody: rank the spawn points by their distance to the
-- nearest other participant and pick randomly among the best few.
local function pickSpawn(forId)
    local spawns = Config.Arena.spawns
    local others = {}
    for id in pairs(participants) do
        if id ~= forId then
            local ped = GetPlayerPed(id)
            if ped and ped ~= 0 then
                others[#others + 1] = GetEntityCoords(ped)
            end
        end
    end

    if #others == 0 then
        return spawns[math.random(#spawns)]
    end

    local ranked = {}
    for i, sp in ipairs(spawns) do
        local nearest = math.huge
        for _, o in ipairs(others) do
            local dx, dy, dz = sp.x - o.x, sp.y - o.y, sp.z - o.z
            local d = math.sqrt(dx * dx + dy * dy + dz * dz)
            if d < nearest then nearest = d end
        end
        ranked[#ranked + 1] = { idx = i, nearest = nearest }
    end
    table.sort(ranked, function(a, b) return a.nearest > b.nearest end)

    local pool = math.min(3, #ranked)
    return spawns[ranked[math.random(pool)].idx]
end

local endRound  -- forward declaration; applyDeath calls it

local function applyDeath(victimId, killerId)
    local victim = participants[victimId]
    if not victim then
        return false, 'victim is not in the arena'
    end

    local now = GetGameTimer()
    if now - victim.lastDeathAt < Config.MinDeathReportGapMs then
        return false, 'death report too soon after the last one'
    end
    victim.lastDeathAt = now
    victim.deaths = victim.deaths + 1

    local killer = killerId and participants[killerId] or nil
    if killer and killerId ~= victimId then
        killer.kills = killer.kills + 1
        log('%s [%d] killed %s [%d] (%d:%d)', killer.name, killerId, victim.name, victimId,
            killer.kills, killer.deaths)
    else
        log('%s [%d] died (no kill credited) (%d:%d)', victim.name, victimId, victim.kills, victim.deaths)
    end

    broadcastScores()

    if roundActive and killer and killer.kills >= Config.KillGoal then
        endRound(killerId)
    end
    return true
end

endRound = function(winnerId)
    local winner = participants[winnerId]
    roundActive = false
    local rows = scoreboard()
    local name = winner and winner.name or 'unknown'
    local kills = winner and winner.kills or 0

    for id in pairs(participants) do
        TriggerClientEvent('ffa-arena:roundOver', id, name, kills, rows)
    end
    log('round over -- %s [%s] wins with %d kills', name, tostring(winnerId), kills)

    SetTimeout(Config.RoundOverBannerMs, function()
        for id, p in pairs(participants) do
            p.kills, p.deaths, p.lastDeathAt = 0, 0, 0
            TriggerClientEvent('ffa-arena:roundStart', id, pickSpawn(id))
        end
        roundActive = true
        broadcastScores()
        log('new round started with %d participant(s)', countParticipants())
    end)
end

-- ---------------------------------------------------------------- client -> server

RegisterNetEvent('ffa-arena:requestJoin', function()
    local src = source
    if participants[src] then
        return
    end
    participants[src] = { name = GetPlayerName(src), kills = 0, deaths = 0, lastDeathAt = 0 }
    SetPlayerRoutingBucket(src, Config.Arena.bucket)

    local spawn = pickSpawn(src)
    TriggerClientEvent('ffa-arena:joined', src, spawn, { arena = Config.ArenaName, goal = Config.KillGoal })
    log('%s [%d] joined the arena (%d in the arena)', participants[src].name, src, countParticipants())
    broadcastScores()
end)

RegisterNetEvent('ffa-arena:requestLeave', function()
    local src = source
    if not participants[src] then
        return
    end
    local name = participants[src].name
    participants[src] = nil
    SetPlayerRoutingBucket(src, Config.Lobby.bucket)
    TriggerClientEvent('ffa-arena:left', src, Config.Lobby.spawn)
    log('%s [%d] left the arena (%d left in)', name, src, countParticipants())
    broadcastScores()
end)

RegisterNetEvent('ffa-arena:reportDeath', function(killerId)
    local src = source
    killerId = tonumber(killerId)
    -- Never trust the client with anything but "I died": the victim is the event source,
    -- and a claimed killer only counts if they are actually in the arena.
    if not killerId or killerId <= 0 or killerId == src or not participants[killerId] then
        killerId = nil
    end
    local ok, why = applyDeath(src, killerId)
    if not ok then
        log('ignored death report from [%d]: %s', src, why)
    end
end)

RegisterNetEvent('ffa-arena:requestRespawn', function()
    local src = source
    if not participants[src] then
        return
    end
    TriggerClientEvent('ffa-arena:spawnAt', src, pickSpawn(src))
end)

AddEventHandler('playerDropped', function()
    local src = source
    if participants[src] then
        log('%s [%d] dropped, removed from the arena', participants[src].name, src)
        participants[src] = nil
        broadcastScores()
    end
end)

-- ---------------------------------------------------------------- lifecycle

AddEventHandler('onResourceStart', function(res)
    if res ~= RES then return end
    SetRoutingBucketEntityLockdownMode(Config.Arena.bucket, 'relaxed')
    SetRoutingBucketPopulationEnabled(Config.Arena.bucket, false)
    log('ready -- arena "%s", bucket %d, %d spawn point(s), first to %d kills',
        Config.ArenaName, Config.Arena.bucket, #Config.Arena.spawns, Config.KillGoal)
end)

AddEventHandler('onResourceStop', function(res)
    if res ~= RES then return end
    -- Synchronous only. Put everyone back into the lobby bucket so a stop never leaves a
    -- player stranded in an empty world.
    for id in pairs(participants) do
        SetPlayerRoutingBucket(id, Config.Lobby.bucket)
    end
    participants = {}
end)
