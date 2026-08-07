-- ffa-arena :: client
-- Lobby presentation (blip + join marker), arena entry/exit, loadout, death detection,
-- automatic respawn and the NUI scoreboard. All scoring lives on the server.

local RES = GetCurrentResourceName()

local S = {
    inArena         = false,
    joining         = false,
    dead            = false,
    awaitingSpawn   = false,
    respawnAt       = 0,
    protectedUntil  = 0,
    arena           = Config.ArenaName,
    goal            = Config.KillGoal,
    rows            = {},
    joinBlip        = nil,
    autoSpawnWasOn  = true,
}

local function log(fmt, ...)
    print(('[ffa-arena] ' .. fmt):format(...))
end

local function nui(msg)
    SendNUIMessage(msg)
end

-- spawnmanager owns the default respawn. While in the arena we do the respawning,
-- so its auto spawn has to be off or it drops us back on a map spawn point.
local function setAutoSpawn(enabled)
    local ok = pcall(function()
        exports.spawnmanager:setAutoSpawn(enabled)
    end)
    if not ok then
        log('spawnmanager not available -- auto spawn left as it is')
    end
    return ok
end

local function applyLoadout(ped)
    RemoveAllPedWeapons(ped, true)
    SetPedArmour(ped, Config.Loadout.armour)
    for _, w in ipairs(Config.Loadout.weapons) do
        GiveWeaponToPed(ped, GetHashKey(w.name), w.ammo, false, false)
    end
    if Config.Loadout.selected then
        SetCurrentPedWeapon(ped, GetHashKey(Config.Loadout.selected), true)
    end
end

-- Player-level invincibility on purpose: SetEntityInvincible does not show up in
-- GetPlayerInvincible, so the protection window would not be observable from outside.
local function grantSpawnProtection()
    SetPlayerInvincible(PlayerId(), true)
    S.protectedUntil = GetGameTimer() + Config.SpawnProtectionMs
    nui({ action = 'protection', ms = Config.SpawnProtectionMs })
    CreateThread(function()
        while GetGameTimer() < S.protectedUntil do Wait(100) end
        SetPlayerInvincible(PlayerId(), false)
        S.protectedUntil = 0
    end)
end

-- Places the ped at a spawn point behind a short fade. Everything that can fail runs
-- before the fade out, and the fade in is unconditional, so a failure can never strand
-- the player on a black screen.
local function moveTo(spawn, withLoadout)
    if withLoadout then
        applyLoadout(PlayerPedId())
    end
    CreateThread(function()
        DoScreenFadeOut(250)
        local t = GetGameTimer()
        while not IsScreenFadedOut() and GetGameTimer() - t < 1200 do Wait(0) end

        local ok, err = pcall(function()
            local ped = PlayerPedId()
            RequestCollisionAtCoord(spawn.x + 0.0, spawn.y + 0.0, spawn.z + 0.0)
            SetEntityCoordsNoOffset(ped, spawn.x + 0.0, spawn.y + 0.0, spawn.z + 0.0, false, false, false)
            SetEntityHeading(ped, spawn.h + 0.0)
            local t2 = GetGameTimer()
            while not HasCollisionLoadedAroundEntity(ped) and GetGameTimer() - t2 < 5000 do Wait(50) end
            SetEntityHealth(ped, GetEntityMaxHealth(ped))
        end)
        if not ok then
            log('move to spawn failed: %s', tostring(err))
        end

        DoScreenFadeIn(350)
    end)
end

local function resurrectAt(spawn)
    NetworkResurrectLocalPlayer(spawn.x + 0.0, spawn.y + 0.0, spawn.z + 0.0, spawn.h + 0.0, 0, false)
    local ped = PlayerPedId()
    ClearPedBloodDamage(ped)
    SetEntityHealth(ped, GetEntityMaxHealth(ped))
    applyLoadout(ped)
    grantSpawnProtection()
    S.dead = false
    S.awaitingSpawn = false
    nui({ action = 'alive' })
end

local function pushState()
    nui({
        action = 'state',
        inArena = S.inArena,
        arena = S.arena,
        goal = S.goal,
        you = GetPlayerServerId(PlayerId()),
    })
end

-- ---------------------------------------------------------------- lobby presentation

local function createJoinBlip()
    if S.joinBlip then return end
    local jp = Config.Lobby.joinPoint
    local blip = AddBlipForCoord(jp.x + 0.0, jp.y + 0.0, jp.z + 0.0)
    SetBlipSprite(blip, Config.Lobby.blipSprite)
    SetBlipColour(blip, Config.Lobby.blipColor)
    SetBlipScale(blip, 0.9)
    SetBlipAsShortRange(blip, true)
    BeginTextCommandSetBlipName('STRING')
    AddTextComponentSubstringPlayerName('FFA Arena')
    EndTextCommandSetBlipName(blip)
    S.joinBlip = blip
end

local function removeJoinBlip()
    if S.joinBlip then
        RemoveBlip(S.joinBlip)
        S.joinBlip = nil
    end
end

local function helpText(text)
    BeginTextCommandDisplayHelp('STRING')
    AddTextComponentSubstringPlayerName(text)
    EndTextCommandDisplayHelp(0, false, true, -1)
end

local function requestJoin()
    if S.inArena or S.joining then return end
    S.joining = true
    TriggerServerEvent('ffa-arena:requestJoin')
    SetTimeout(5000, function() S.joining = false end)
end

local function requestLeave()
    if not S.inArena then return end
    TriggerServerEvent('ffa-arena:requestLeave')
end

-- ---------------------------------------------------------------- server -> client

RegisterNetEvent('ffa-arena:joined', function(spawn, info)
    S.joining = false
    S.inArena = true
    S.dead = false
    S.awaitingSpawn = false
    S.arena = (info and info.arena) or Config.ArenaName
    S.goal = (info and info.goal) or Config.KillGoal

    S.autoSpawnWasOn = true
    setAutoSpawn(false)
    NetworkSetFriendlyFireOption(true)
    SetCanAttackFriendly(PlayerPedId(), true, true)
    removeJoinBlip()

    moveTo(spawn, true)
    grantSpawnProtection()
    pushState()
    nui({ action = 'show', show = true })
    log('joined arena "%s" at %.1f %.1f %.1f', S.arena, spawn.x, spawn.y, spawn.z)
end)

RegisterNetEvent('ffa-arena:left', function(spawn)
    S.inArena = false
    S.dead = false
    S.awaitingSpawn = false
    S.rows = {}

    SetPlayerInvincible(PlayerId(), false)
    S.protectedUntil = 0
    RemoveAllPedWeapons(PlayerPedId(), true)
    setAutoSpawn(true)
    createJoinBlip()

    moveTo(spawn, false)
    nui({ action = 'show', show = false })
    log('left the arena')
end)

RegisterNetEvent('ffa-arena:scores', function(rows)
    S.rows = rows or {}
    nui({ action = 'scores', rows = S.rows })
end)

RegisterNetEvent('ffa-arena:spawnAt', function(spawn)
    if not S.inArena then return end
    resurrectAt(spawn)
    log('respawned at %.1f %.1f %.1f', spawn.x, spawn.y, spawn.z)
end)

RegisterNetEvent('ffa-arena:roundOver', function(winnerName, kills, rows)
    if not S.inArena then return end
    S.rows = rows or S.rows
    nui({ action = 'scores', rows = S.rows })
    nui({
        action = 'banner',
        title = ('%s wins the round'):format(winnerName or '?'),
        sub = ('%d kills · next round starting'):format(kills or 0),
        ms = Config.RoundOverBannerMs,
    })
    log('round over -- %s wins with %d kills', tostring(winnerName), kills or 0)
end)

RegisterNetEvent('ffa-arena:roundStart', function(spawn)
    if not S.inArena then return end
    resurrectAt(spawn)
    nui({ action = 'banner', title = 'New round', sub = ('First to %d kills'):format(S.goal), ms = 2500 })
    log('new round started')
end)

-- ---------------------------------------------------------------- death detection

-- Who killed us, as a server id. Environment, suicide and NPC kills report -1: the death
-- still counts, the kill is credited to nobody.
local function resolveKiller(ped)
    local killer = GetPedSourceOfDeath(ped)
    if not killer or killer == 0 or not DoesEntityExist(killer) then return -1 end

    local killerPed = killer
    if IsEntityAVehicle(killer) then
        local driver = GetPedInVehicleSeat(killer, -1)
        if driver and driver ~= 0 then killerPed = driver end
    end
    if not IsEntityAPed(killerPed) or not IsPedAPlayer(killerPed) then return -1 end
    if killerPed == ped then return -1 end

    local idx = NetworkGetPlayerIndexFromPed(killerPed)
    if not idx or idx == -1 then return -1 end
    return GetPlayerServerId(idx)
end

CreateThread(function()
    while true do
        Wait(150)
        if S.inArena then
            local ped = PlayerPedId()
            if not S.dead and IsEntityDead(ped) then
                S.dead = true
                S.awaitingSpawn = false
                S.respawnAt = GetGameTimer() + Config.RespawnDelayMs
                local killer = resolveKiller(ped)
                TriggerServerEvent('ffa-arena:reportDeath', killer)
                nui({ action = 'dead', ms = Config.RespawnDelayMs })
                log('died (killer server id %d), respawn in %d ms', killer, Config.RespawnDelayMs)
            elseif S.dead and not S.awaitingSpawn and GetGameTimer() >= S.respawnAt then
                S.awaitingSpawn = true
                TriggerServerEvent('ffa-arena:requestRespawn')
                -- if the answer is lost, ask again on the next pass
                S.respawnAt = GetGameTimer() + 2000
            end
        end
    end
end)

-- ---------------------------------------------------------------- lobby marker loop

CreateThread(function()
    createJoinBlip()
    local jp = Config.Lobby.joinPoint
    local c = Config.Lobby.markerColor
    while true do
        local sleep = 500
        if not S.inArena then
            local pos = GetEntityCoords(PlayerPedId())
            local dist = #(pos - vector3(jp.x, jp.y, jp.z))
            if dist < 25.0 then
                sleep = 0
                DrawMarker(1, jp.x + 0.0, jp.y + 0.0, jp.z - 0.95, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
                    2.0, 2.0, 0.6, c.r, c.g, c.b, c.a, false, false, 2, false, nil, nil, false)
                if dist < Config.Lobby.joinRadius then
                    helpText('Press ~INPUT_CONTEXT~ to join the ~r~FFA arena~s~')
                    if IsControlJustReleased(0, 38) then
                        requestJoin()
                    end
                end
            end
        end
        Wait(sleep)
    end
end)

-- ---------------------------------------------------------------- commands

-- Deliberately not /ffa: a server may already run another deathmatch resource that owns
-- that verb, and two resources registering the same command is ambiguous.
RegisterCommand('arena', function()
    if S.inArena then
        log('already in the arena -- use /arenaleave to go back to the lobby')
        return
    end
    requestJoin()
end, false)

RegisterCommand('arenaleave', function()
    if not S.inArena then
        log('not in the arena')
        return
    end
    requestLeave()
end, false)

-- ---------------------------------------------------------------- lifecycle

AddEventHandler('onResourceStop', function(res)
    if res ~= RES then return end
    -- Strictly synchronous: this coroutine is destroyed at its first yield, so no Wait()
    -- and no CreateThread here. The server resets the routing bucket on its own stop.
    SetPlayerInvincible(PlayerId(), false)
    DoScreenFadeIn(0)
    if S.inArena then
        RemoveAllPedWeapons(PlayerPedId(), true)
    end
    if S.joinBlip then RemoveBlip(S.joinBlip) end
    pcall(function() exports.spawnmanager:setAutoSpawn(true) end)
end)

CreateThread(function()
    Wait(500)
    pushState()
    nui({ action = 'show', show = false })
    log('client ready -- walk into the lobby marker or use /arena')
end)
