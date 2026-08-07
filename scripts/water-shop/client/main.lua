--- Client side: the counter you walk up to, and the window it opens.
--
-- No money, price or stock decision is made here. The client asks the server
-- what is for sale, shows it, and forwards what the player clicked.

local shopOpen = false
local nearestShop = nil     -- { index, shop, distance } while in range
local awaitingCatalog = false

local HELP_KEY = 'WATER_SHOP_HELP'
AddTextEntry(HELP_KEY, ('Press ~INPUT_PICKUP~ to browse %s'):format(Config.ShopName))

local function notify(message)
    BeginTextCommandThefeedPost('STRING')
    AddTextComponentSubstringPlayerName(message)
    EndTextCommandThefeedPostTicker(false, true)
end

local function toNui(payload)
    SendNuiMessage(json.encode(payload))
end

-- ---------------------------------------------------------------------------
-- Blips
-- ---------------------------------------------------------------------------

if Config.Blip.enabled then
    CreateThread(function()
        for _, shop in ipairs(Config.Shops) do
            local blip = AddBlipForCoord(shop.coords.x, shop.coords.y, shop.coords.z)
            SetBlipSprite(blip, Config.Blip.sprite)
            SetBlipColour(blip, Config.Blip.color)
            SetBlipScale(blip, Config.Blip.scale)
            SetBlipAsShortRange(blip, Config.Blip.shortRange)
            BeginTextCommandSetBlipName('STRING')
            AddTextComponentSubstringPlayerName(Config.ShopName)
            EndTextCommandSetBlipName(blip)
        end
    end)
end

-- ---------------------------------------------------------------------------
-- Opening and closing
-- ---------------------------------------------------------------------------

local function closeShop()
    if not shopOpen then return end
    shopOpen = false
    SetNuiFocus(false, false)
    toNui({ action = 'close' })
end

local function openShop()
    if shopOpen or awaitingCatalog or not nearestShop then return end
    awaitingCatalog = true
    TriggerServerEvent('water-shop:requestCatalog')
end

RegisterNetEvent('water-shop:catalog', function(payload)
    awaitingCatalog = false

    if not payload or not payload.ok then
        notify(payload and payload.message or 'The shop is closed.')
        return
    end

    shopOpen = true
    SetNuiFocus(true, true)
    payload.action = 'open'
    toNui(payload)
end)

RegisterNetEvent('water-shop:purchaseResult', function(payload)
    if not payload then return end

    if not shopOpen then
        -- The window was closed while the request was in flight; the player
        -- still deserves to know how it went.
        notify(payload.ok and ('Purchased ' .. payload.message) or payload.message)
        return
    end

    payload.action = 'result'
    toNui(payload)
end)

-- ---------------------------------------------------------------------------
-- NUI callbacks
-- ---------------------------------------------------------------------------

RegisterNuiCallback('close', function(_, cb)
    closeShop()
    cb({ ok = true })
end)

RegisterNuiCallback('purchase', function(data, cb)
    if not shopOpen then
        cb({ ok = false })
        return
    end

    -- Passed straight through; the server validates all three.
    TriggerServerEvent('water-shop:purchase', data.txId, data.itemId, data.quantity)
    cb({ ok = true })
end)

-- ---------------------------------------------------------------------------
-- Proximity
-- ---------------------------------------------------------------------------

-- Coarse pass: which counter, if any, is worth drawing.
CreateThread(function()
    while true do
        local coords = GetEntityCoords(PlayerPedId())
        local best, bestDistance = nil, math.huge

        for index, shop in ipairs(Config.Shops) do
            local distance = #(coords - shop.coords)
            if distance < bestDistance then
                best, bestDistance = index, distance
            end
        end

        if best and bestDistance <= Config.Marker.drawDistance then
            nearestShop = { index = best, shop = Config.Shops[best], distance = bestDistance }
            Wait(200)
        else
            if nearestShop and shopOpen then
                closeShop()
            end
            nearestShop = nil
            Wait(1000)
        end
    end
end)

-- Fine pass: only runs every frame while a counter is actually in view.
CreateThread(function()
    while true do
        if not nearestShop then
            Wait(500)
        else
            local shop = nearestShop.shop
            local marker = Config.Marker
            DrawMarker(marker.type,
                shop.coords.x, shop.coords.y, shop.coords.z + marker.zOffset,
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
                marker.scale.x, marker.scale.y, marker.scale.z,
                marker.color.r, marker.color.g, marker.color.b, marker.color.a,
                false, false, 2, false, nil, nil, false)

            if not shopOpen and nearestShop.distance <= Config.InteractDistance then
                BeginTextCommandDisplayHelp(HELP_KEY)
                EndTextCommandDisplayHelp(0, false, true, -1)

                if IsControlJustReleased(0, Config.OpenControl) then
                    openShop()
                end
            end

            Wait(0)
        end
    end
end)

-- Walking away from the counter closes the window.
CreateThread(function()
    while true do
        Wait(400)
        if shopOpen then
            local distance = nearestShop and nearestShop.distance or math.huge
            if distance > Config.InteractDistance + 2.0 then
                closeShop()
            end
        end
    end
end)

-- ---------------------------------------------------------------------------
-- Teardown
--
-- Must be strictly synchronous: the handler's coroutine is destroyed at its
-- first yield, so anything after a Wait() would never run and the player would
-- be left with a focused, invisible NUI.
-- ---------------------------------------------------------------------------

AddEventHandler('onResourceStop', function(resourceName)
    if resourceName ~= GetCurrentResourceName() then return end
    SetNuiFocus(false, false)
end)
