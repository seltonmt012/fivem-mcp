--- Server-authoritative shop logic.
--
-- Everything a client sends is treated as a claim, never as a fact. The client
-- may say *what* it wants to buy and *how many*; the price, the stock, the
-- player's position, the balance and the outcome are all decided here.

local itemsById = {}
local stock = {}          -- [itemId] = remaining, only for limited lines

for _, item in ipairs(Config.Items) do
    itemsById[item.id] = item
    if item.stock then
        stock[item.id] = item.stock
    end
end

-- Per-player transaction state. Cleared when the player leaves.
local sessions = {}

local function sessionFor(src)
    local session = sessions[src]
    if not session then
        session = { busy = false, lastPurchaseAt = 0, attempts = {}, transactions = {} }
        sessions[src] = session
    end
    return session
end

AddEventHandler('playerDropped', function()
    sessions[source] = nil
end)

-- ---------------------------------------------------------------------------
-- Validation helpers
-- ---------------------------------------------------------------------------

local function isCountInRange(value, max)
    if type(value) ~= 'number' then return false end
    if value ~= value then return false end                 -- NaN
    if value ~= math.floor(value) then return false end      -- fractional
    if value < 1 or value > max then return false end        -- also rejects inf
    return true
end

local function isValidTxId(value)
    return type(value) == 'string'
        and #value >= 8 and #value <= 64
        and value:match('^[%w%-]+$') ~= nil
end

--- The counter the player is actually standing at, or nil.
-- Read from the server's own copy of the player's position, so a client that
-- claims to be at a shop while standing somewhere else gets nothing.
local function shopNear(src)
    local ped = GetPlayerPed(src)
    if not ped or ped == 0 then return nil end

    local coords = GetEntityCoords(ped)
    for _, shop in ipairs(Config.Shops) do
        if #(coords - shop.coords) <= Config.ServerDistanceTolerance then
            return shop
        end
    end
    return nil
end

--- Sliding-window rate limit over purchase attempts, accepted or refused.
local function withinRateLimit(session, now)
    local kept = {}
    for _, at in ipairs(session.attempts) do
        if now - at < Config.Security.rateWindowMs then
            kept[#kept + 1] = at
        end
    end
    kept[#kept + 1] = now
    session.attempts = kept
    return #kept <= Config.Security.rateMaxAttempts
end

local function forgetOldTransactions(session, now)
    for txId, record in pairs(session.transactions) do
        if now - record.at > Config.Security.txMemoryMs then
            session.transactions[txId] = nil
        end
    end
end

-- ---------------------------------------------------------------------------
-- Catalogue snapshot
-- ---------------------------------------------------------------------------

local function catalogFor(src)
    local list = {}
    for index, item in ipairs(Config.Items) do
        local entry = {
            id = item.id,
            label = item.label,
            detail = item.detail,
            price = item.price,
            maxPerPurchase = item.maxPerPurchase,
            art = item.art,
            limited = item.stock ~= nil,
            owned = Bridge.GetItemCount(src, item.id),
        }
        if item.stock ~= nil then
            entry.stock = stock[item.id]
        end
        list[index] = entry
    end
    return list
end

local function stateFor(src, shop)
    return {
        shopName = Config.ShopName,
        location = shop and shop.label or '',
        currency = Config.CurrencyPrefix,
        moneyLabel = Bridge.moneyLabel,
        balance = Bridge.GetBalance(src),
        items = catalogFor(src),
    }
end

-- ---------------------------------------------------------------------------
-- Opening the shop
-- ---------------------------------------------------------------------------

RegisterNetEvent('water-shop:requestCatalog', function()
    local src = source

    local shop = shopNear(src)
    if not shop then
        TriggerClientEvent('water-shop:catalog', src, { ok = false, message = 'You are not at a shop counter.' })
        return
    end

    local payload = stateFor(src, shop)
    payload.ok = true
    TriggerClientEvent('water-shop:catalog', src, payload)
end)

-- ---------------------------------------------------------------------------
-- Buying
-- ---------------------------------------------------------------------------

local function refuse(src, txId, message)
    TriggerClientEvent('water-shop:purchaseResult', src, {
        txId = txId,
        ok = false,
        message = message,
        balance = Bridge.GetBalance(src),
        items = catalogFor(src),
    })
end

RegisterNetEvent('water-shop:purchase', function(txId, itemId, quantity)
    local src = source
    local session = sessionFor(src)
    local now = GetGameTimer()

    -- A malformed transaction id cannot be de-duplicated, so it is refused
    -- before anything else happens.
    if not isValidTxId(txId) then
        print(('[water-shop] rejected malformed transaction id from %s (%s)'):format(GetPlayerName(src) or '?', src))
        return
    end

    if not withinRateLimit(session, now) then
        refuse(src, txId, 'Slow down.')
        return
    end

    -- Replay / double-send: the request is answered from the record of the
    -- original transaction and is never charged a second time.
    forgetOldTransactions(session, now)
    local previous = session.transactions[txId]
    if previous then
        TriggerClientEvent('water-shop:purchaseResult', src, {
            txId = txId,
            ok = previous.ok,
            message = previous.message,
            balance = Bridge.GetBalance(src),
            items = catalogFor(src),
        })
        return
    end

    -- One purchase in flight per player. Set before any other work and cleared
    -- on every exit path below.
    if session.busy then
        refuse(src, txId, 'A purchase is already going through.')
        return
    end
    session.busy = true

    local function finish(ok, message)
        session.busy = false
        session.transactions[txId] = { at = now, ok = ok, message = message }
        if ok then
            session.lastPurchaseAt = now
        end
        TriggerClientEvent('water-shop:purchaseResult', src, {
            txId = txId,
            ok = ok,
            message = message,
            balance = Bridge.GetBalance(src),
            items = catalogFor(src),
        })
    end

    if now - session.lastPurchaseAt < Config.Security.purchaseCooldownMs then
        session.busy = false
        refuse(src, txId, 'One moment.')
        return
    end

    if type(itemId) ~= 'string' then
        session.busy = false
        refuse(src, txId, 'Unknown product.')
        return
    end

    local item = itemsById[itemId]
    if not item then
        session.busy = false
        refuse(src, txId, 'Unknown product.')
        print(('[water-shop] %s (%s) asked for unlisted item %q'):format(GetPlayerName(src) or '?', src, itemId))
        return
    end

    if not isCountInRange(quantity, item.maxPerPurchase) then
        session.busy = false
        refuse(src, txId, ('You can take at most %d of that at a time.'):format(item.maxPerPurchase))
        return
    end

    local shop = shopNear(src)
    if not shop then
        session.busy = false
        refuse(src, txId, 'You are not at a shop counter.')
        print(('[water-shop] %s (%s) tried to buy from out of range'):format(GetPlayerName(src) or '?', src))
        return
    end

    if item.stock ~= nil and stock[item.id] < quantity then
        finish(false, stock[item.id] == 0 and 'Sold out.' or ('Only %d left.'):format(stock[item.id]))
        return
    end

    -- Price comes from the config, never from the request.
    local total = item.price * quantity

    if not Bridge.CanCarry(src, item.id, quantity) then
        finish(false, 'You cannot carry that many.')
        return
    end

    if Bridge.GetBalance(src) < total then
        finish(false, ('You need %s%d.'):format(Config.CurrencyPrefix, total))
        return
    end

    -- Charge first: TakeMoney re-checks the balance itself, so two requests
    -- that somehow reach this point together cannot both succeed.
    if not Bridge.TakeMoney(src, total) then
        finish(false, ('You need %s%d.'):format(Config.CurrencyPrefix, total))
        return
    end

    if not Bridge.GiveItem(src, item.id, quantity) then
        Bridge.RefundMoney(src, total)
        finish(false, 'The register jammed. You were not charged.')
        print(('[water-shop] item grant failed for %s (%s), refunded %d'):format(GetPlayerName(src) or '?', src, total))
        return
    end

    if item.stock ~= nil then
        stock[item.id] = stock[item.id] - quantity
    end

    print(('[water-shop] %s (%s) bought %dx %s for %s%d at %s'):format(
        GetPlayerName(src) or '?', src, quantity, item.id, Config.CurrencyPrefix, total, shop.label))

    finish(true, ('%dx %s'):format(quantity, item.label))
end)

-- ---------------------------------------------------------------------------
-- Restocking
-- ---------------------------------------------------------------------------

CreateThread(function()
    local interval = Config.RestockMinutes * 60000
    while true do
        Wait(interval)
        for _, item in ipairs(Config.Items) do
            if item.stock ~= nil and stock[item.id] < item.stock then
                stock[item.id] = item.stock
            end
        end
    end
end)

-- Providers are chosen once, at load, before any event handler can run.
Bridge.Init()
