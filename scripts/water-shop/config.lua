Config = {}

-- ---------------------------------------------------------------------------
-- Presentation
-- ---------------------------------------------------------------------------

Config.ShopName = '24/7 Hydration'
Config.CurrencyPrefix = '$'

-- ---------------------------------------------------------------------------
-- Where the shop can be used
--
-- Every entry is a counter a player can trade at. The server validates the
-- player's real position against this same list, so adding a location here is
-- the only way to make it purchasable.
-- ---------------------------------------------------------------------------

Config.Shops = {
    { label = '24/7 Supermarket, Innocence Blvd', coords = vector3(24.53, -1346.97, 29.5) },
    { label = '24/7 Supermarket, Palomino Ave',   coords = vector3(-706.16, -914.63, 19.22) },
    { label = 'Rob\'s Liquor, Prosperity St',     coords = vector3(-1222.15, -906.72, 12.33) },
    { label = 'LTD Gasoline, Grove St',           coords = vector3(-47.47, -1758.32, 29.42) },
}

-- How close the player has to stand to interact, in metres.
Config.InteractDistance = 2.0

-- The server re-checks distance on every purchase. It allows a little more
-- than the client does, because position replication lags a few metres behind
-- a moving player and we do not want honest buyers rejected.
Config.ServerDistanceTolerance = 8.0

-- INPUT_PICKUP -- the "E" key by default.
Config.OpenControl = 38

Config.Marker = {
    type = 27,
    scale = vector3(0.9, 0.9, 0.4),
    color = { r = 64, g = 196, b = 255, a = 130 },
    drawDistance = 12.0,
    zOffset = -0.97,
}

Config.Blip = {
    enabled = true,
    sprite = 52,       -- convenience store
    color = 3,         -- light blue
    scale = 0.75,
    shortRange = true,
}

-- ---------------------------------------------------------------------------
-- Catalogue
--
-- Prices live here and only here. The client is sent this catalogue for
-- display, but the server always re-reads the price from this table when it
-- charges -- a client that sends its own price is ignored.
--
-- stock = nil means the line is always available. A number is a real server
-- side count that depletes as players buy and refills on the restock timer.
-- ---------------------------------------------------------------------------

Config.Items = {
    {
        id = 'water_bottle',
        label = 'Spring Water',
        detail = '500 ml still water, chilled.',
        price = 4,
        maxPerPurchase = 10,
        stock = nil,
        art = 'still',
    },
    {
        id = 'water_sparkling',
        label = 'Sparkling Water',
        detail = '500 ml carbonated, lightly mineralised.',
        price = 6,
        maxPerPurchase = 10,
        stock = nil,
        art = 'sparkling',
    },
    {
        id = 'water_pack',
        label = 'Water 6-Pack',
        detail = 'Six 500 ml bottles. Cheaper by the bottle.',
        price = 20,
        maxPerPurchase = 5,
        stock = nil,
        art = 'pack',
    },
    {
        id = 'water_glacier',
        label = 'Glacier Reserve',
        detail = '1 L imported glacial water. Limited delivery.',
        price = 45,
        maxPerPurchase = 3,
        stock = 25,
        art = 'glacier',
    },
}

-- Limited lines refill to their configured stock this often.
Config.RestockMinutes = 30

-- ---------------------------------------------------------------------------
-- Abuse limits (server-enforced)
-- ---------------------------------------------------------------------------

Config.Security = {
    -- Minimum gap between two completed purchases by the same player.
    purchaseCooldownMs = 600,

    -- Sliding window rate limit on purchase attempts, successful or not.
    rateWindowMs = 10000,
    rateMaxAttempts = 12,

    -- How long a completed transaction id is remembered, so a replayed or
    -- double-sent request is answered from the record instead of charged again.
    txMemoryMs = 60000,
}

-- ---------------------------------------------------------------------------
-- Standalone fallback
--
-- Only used when no supported framework is running. Wallet and inventory are
-- persisted per account with the server KVS.
-- ---------------------------------------------------------------------------

Config.Standalone = {
    startingBalance = 250,
    maxStackPerItem = 100,
    moneyLabel = 'Cash',
}
