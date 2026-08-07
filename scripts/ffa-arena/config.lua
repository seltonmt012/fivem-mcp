-- Shared configuration. Loaded on both sides before anything else.
-- Coordinates are plain tables (not vector3/vector4) because they travel over net events.

Config = {}

Config.ArenaName = 'Sandy Shores Airfield'

-- Kills needed to win a round. Reaching it ends the round and resets every score.
Config.KillGoal = 15

Config.Lobby = {
    -- Routing bucket lobby players live in (0 = the default world).
    bucket = 0,
    -- Where a player is put when leaving the arena. (measured ground 29.85)
    spawn = { x = 213.62, y = -804.65, z = 30.85, h = 145.0 },
    -- Walk into this marker and press E to join. (measured ground 29.76)
    joinPoint = { x = 218.5, y = -799.5, z = 30.76 },
    joinRadius = 1.6,
    markerColor = { r = 240, g = 80, b = 40, a = 130 },
    blipSprite = 313,
    blipColor = 1,
}

Config.Arena = {
    -- Arena players are moved into their own routing bucket, so the lobby is a
    -- separate world: no lobby player can be seen or shot from inside the arena.
    bucket = 50,
    -- Random spawn points. The server picks the one furthest from the living
    -- opposition, so nobody materialises in front of a rifle.
    -- z values are the ground height measured in-game plus 0.2.
    spawns = {
        { x = 1707.4, y = 3272.1, z = 40.35, h = 195.0 },
        { x = 1758.5, y = 3288.2, z = 40.34, h = 255.0 },
        { x = 1690.2, y = 3216.6, z = 40.66, h = 15.0 },
        { x = 1637.9, y = 3237.4, z = 39.61, h = 105.0 },
        { x = 1747.1, y = 3212.9, z = 42.24, h = 330.0 },
        { x = 1794.6, y = 3266.4, z = 41.60, h = 285.0 },
        { x = 1665.0, y = 3299.6, z = 40.26, h = 150.0 },
        { x = 1770.0, y = 3240.0, z = 41.32, h = 45.0 },
    },
}

Config.Loadout = {
    armour = 100,
    -- Given in order; the last entry is selected on spawn.
    weapons = {
        { name = 'WEAPON_PUMPSHOTGUN', ammo = 60 },
        { name = 'WEAPON_COMBATPISTOL', ammo = 250 },
        { name = 'WEAPON_CARBINERIFLE', ammo = 250 }, -- 250 is the engine's cap for this weapon
    },
    selected = 'WEAPON_CARBINERIFLE',
}

-- How long a corpse lies there before the automatic respawn fires.
Config.RespawnDelayMs = 4000
-- Invincibility granted right after a spawn, so a spawn is never a free kill.
Config.SpawnProtectionMs = 3000
-- Server-side floor between two death reports of the same player (anti-spam).
Config.MinDeathReportGapMs = 1200
-- How long the round-over banner stays up before the next round starts.
Config.RoundOverBannerMs = 6000
-- Rows the scoreboard shows at most.
Config.ScoreboardRows = 12
