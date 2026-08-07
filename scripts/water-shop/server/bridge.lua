--- Framework adapter.
--
-- The shop logic in server/main.lua never talks to a framework directly; it
-- goes through Bridge. At startup we look at what is actually running and pick
-- a money provider and an inventory provider independently -- a server can run
-- ESX for money and ox_inventory for items, which is a common pairing.
--
-- When nothing supported is present we fall back to a self-contained wallet and
-- inventory persisted in the server KVS, keyed on the player's account. That
-- keeps the resource usable on a bare server without pretending a framework is
-- there.

Bridge = {}

local money    -- provider table: get(src), take(src, amount) -> ok
local items    -- provider table: canCarry, add, count
local ESX, QBCore

local function running(resource)
    return GetResourceState(resource) == 'started'
end

-- ---------------------------------------------------------------------------
-- Account identity for the standalone providers
-- ---------------------------------------------------------------------------

local accountKeys = {}

--- Resolves a stable, persistent key for a player.
-- Prefers the account id from the `cfx.re/playerData.v1alpha1` spec (the
-- player-data resource shipped with cfx-server-data implements it) and falls
-- back to the Rockstar license identifier, which is equally stable.
local function accountKey(src)
    local cached = accountKeys[src]
    if cached then return cached end

    local key
    if running('player-data') then
        local ok, id = pcall(function()
            return exports['cfx.re/playerData.v1alpha1']:getPlayerId(tostring(src))
        end)
        if ok and id then
            key = ('account:%s'):format(id)
        end
    end

    if not key then
        local player = tostring(src)
        for index = 0, GetNumPlayerIdentifiers(player) - 1 do
            local identifier = GetPlayerIdentifier(player, index)
            if identifier and identifier:sub(1, 8) == 'license:' then
                key = identifier
                break
            end
        end
    end

    accountKeys[src] = key
    return key
end

AddEventHandler('playerDropped', function()
    accountKeys[source] = nil
end)

-- ---------------------------------------------------------------------------
-- Standalone providers (KVS backed)
-- ---------------------------------------------------------------------------

-- Declared empty and filled with `function name.field()` statements: a member
-- written inside a `local t = { ... }` constructor cannot refer to `t`, because
-- the local only comes into scope after the assignment finishes.

local standaloneMoney = {}
standaloneMoney.label = Config.Standalone.moneyLabel

function standaloneMoney.get(src)
    local key = accountKey(src)
    if not key then return 0 end

    -- GetResourceKvpInt returns 0 for an unset key, which is indistinguishable
    -- from a spent-out wallet, so first use is recorded with a separate marker
    -- before the starting balance is granted.
    if GetResourceKvpString(('opened:%s'):format(key)) == nil then
        SetResourceKvp(('opened:%s'):format(key), '1')
        SetResourceKvpInt(('wallet:%s'):format(key), Config.Standalone.startingBalance)
        return Config.Standalone.startingBalance
    end

    return GetResourceKvpInt(('wallet:%s'):format(key))
end

function standaloneMoney.take(src, amount)
    local key = accountKey(src)
    if not key then return false end

    local balance = standaloneMoney.get(src)
    if balance < amount then return false end

    SetResourceKvpInt(('wallet:%s'):format(key), balance - amount)
    return true
end

function standaloneMoney.give(src, amount)
    local key = accountKey(src)
    if not key then return false end

    SetResourceKvpInt(('wallet:%s'):format(key), standaloneMoney.get(src) + amount)
    return true
end

local standaloneItems = {}

function standaloneItems.count(src, itemId)
    local key = accountKey(src)
    if not key then return 0 end
    return GetResourceKvpInt(('inv:%s:%s'):format(key, itemId))
end

function standaloneItems.canCarry(src, itemId, quantity)
    return standaloneItems.count(src, itemId) + quantity <= Config.Standalone.maxStackPerItem
end

function standaloneItems.add(src, itemId, quantity)
    local key = accountKey(src)
    if not key then return false end

    SetResourceKvpInt(('inv:%s:%s'):format(key, itemId),
        standaloneItems.count(src, itemId) + quantity)
    return true
end

-- ---------------------------------------------------------------------------
-- Framework providers
-- ---------------------------------------------------------------------------

local function esxProviders()
    local ok, obj = pcall(function() return exports['es_extended']:getSharedObject() end)
    if not ok or not obj then return nil end
    ESX = obj

    local m = {
        label = 'Cash',
        get = function(src)
            local xPlayer = ESX.GetPlayerFromId(src)
            return xPlayer and xPlayer.getMoney() or 0
        end,
        take = function(src, amount)
            local xPlayer = ESX.GetPlayerFromId(src)
            if not xPlayer or xPlayer.getMoney() < amount then return false end
            xPlayer.removeMoney(amount)
            return true
        end,
        give = function(src, amount)
            local xPlayer = ESX.GetPlayerFromId(src)
            if not xPlayer then return false end
            xPlayer.addMoney(amount)
            return true
        end,
    }

    local i = {
        count = function(src, itemId)
            local xPlayer = ESX.GetPlayerFromId(src)
            if not xPlayer then return 0 end
            local item = xPlayer.getInventoryItem(itemId)
            return item and item.count or 0
        end,
        canCarry = function(src, itemId, quantity)
            local xPlayer = ESX.GetPlayerFromId(src)
            if not xPlayer then return false end
            return xPlayer.canCarryItem(itemId, quantity)
        end,
        add = function(src, itemId, quantity)
            local xPlayer = ESX.GetPlayerFromId(src)
            if not xPlayer then return false end
            xPlayer.addInventoryItem(itemId, quantity)
            return true
        end,
    }

    return m, i
end

local function qbProviders()
    local ok, obj = pcall(function() return exports['qb-core']:GetCoreObject() end)
    if not ok or not obj then return nil end
    QBCore = obj

    local m = {
        label = 'Cash',
        get = function(src)
            local player = QBCore.Functions.GetPlayer(src)
            return player and player.PlayerData.money.cash or 0
        end,
        take = function(src, amount)
            local player = QBCore.Functions.GetPlayer(src)
            if not player then return false end
            return player.Functions.RemoveMoney('cash', amount, 'water-shop') and true or false
        end,
        give = function(src, amount)
            local player = QBCore.Functions.GetPlayer(src)
            if not player then return false end
            return player.Functions.AddMoney('cash', amount, 'water-shop-refund') and true or false
        end,
    }

    local i = {
        count = function(src, itemId)
            local player = QBCore.Functions.GetPlayer(src)
            if not player then return 0 end
            local item = player.Functions.GetItemByName(itemId)
            return item and item.amount or 0
        end,
        canCarry = function(src, itemId, quantity)
            -- qb-inventory exposes a weight check; when it is absent we let the
            -- AddItem call itself be the authority.
            local okCheck, result = pcall(function()
                return exports['qb-inventory']:CanAddItem(src, itemId, quantity)
            end)
            if okCheck and result ~= nil then return result and true or false end
            return true
        end,
        add = function(src, itemId, quantity)
            local player = QBCore.Functions.GetPlayer(src)
            if not player then return false end
            return player.Functions.AddItem(itemId, quantity) and true or false
        end,
    }

    return m, i
end

local function oxItems()
    return {
        count = function(src, itemId)
            local ok, n = pcall(function()
                return exports.ox_inventory:GetItemCount(src, itemId)
            end)
            return (ok and n) or 0
        end,
        canCarry = function(src, itemId, quantity)
            local ok, result = pcall(function()
                return exports.ox_inventory:CanCarryItem(src, itemId, quantity)
            end)
            if not ok then return false end
            return result and true or false
        end,
        add = function(src, itemId, quantity)
            local ok, result = pcall(function()
                return exports.ox_inventory:AddItem(src, itemId, quantity)
            end)
            return ok and result and true or false
        end,
    }
end

-- ---------------------------------------------------------------------------
-- Selection
-- ---------------------------------------------------------------------------

function Bridge.Init()
    local frameworkName = 'standalone'

    if running('es_extended') then
        local m, i = esxProviders()
        if m then
            money, items, frameworkName = m, i, 'ESX'
        end
    elseif running('qb-core') then
        local m, i = qbProviders()
        if m then
            money, items, frameworkName = m, i, 'QBCore'
        end
    end

    -- ox_inventory owns items outright when present, whatever the framework is.
    if running('ox_inventory') then
        items = oxItems()
        Bridge.inventoryName = 'ox_inventory'
    else
        Bridge.inventoryName = frameworkName == 'standalone' and 'standalone (kvs)' or frameworkName
    end

    money = money or standaloneMoney
    items = items or standaloneItems

    Bridge.frameworkName = frameworkName
    Bridge.moneyLabel = money.label or 'Cash'

    print(('[water-shop] money: %s | inventory: %s'):format(frameworkName, Bridge.inventoryName))
end

-- ---------------------------------------------------------------------------
-- Public surface used by server/main.lua
-- ---------------------------------------------------------------------------

-- A provider that throws must fail closed -- no money moved, no item granted --
-- but it must never fail silently, or a broken framework integration is
-- indistinguishable from a player who is simply out of cash.
local function guarded(what, fn, ...)
    local ok, result = pcall(fn, ...)
    if not ok then
        print(('[water-shop] %s provider error: %s'):format(what, tostring(result)))
        return nil
    end
    return result
end

function Bridge.GetBalance(src)
    local value = guarded('money.get', money.get, src)
    if type(value) ~= 'number' then return 0 end
    return math.floor(value)
end

function Bridge.TakeMoney(src, amount)
    return guarded('money.take', money.take, src, amount) and true or false
end

function Bridge.RefundMoney(src, amount)
    return guarded('money.give', money.give, src, amount) and true or false
end

function Bridge.CanCarry(src, itemId, quantity)
    return guarded('inventory.canCarry', items.canCarry, src, itemId, quantity) and true or false
end

function Bridge.GiveItem(src, itemId, quantity)
    return guarded('inventory.add', items.add, src, itemId, quantity) and true or false
end

function Bridge.GetItemCount(src, itemId)
    local value = guarded('inventory.count', items.count, src, itemId)
    if type(value) ~= 'number' then return 0 end
    return math.floor(value)
end
