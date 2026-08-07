# water-shop

A convenience-store water shop: walk up to a counter, press **E**, buy bottled water from a
responsive NUI. Every purchase is decided on the server.

## Install

1. Link or copy the folder into the server's `resources/` tree (any category folder works):

   ```
   cmd /c mklink /J "<resources>\[local]\water-shop" "<repo>\scripts\water-shop"
   ```

2. `refresh` then `ensure water-shop` in the server console.
3. To keep it across server restarts, add `ensure water-shop` to `server.cfg`.

## Framework integration

`server/bridge.lua` picks a money provider and an inventory provider at startup, independently,
and prints which ones it chose:

| Detected | Money | Inventory |
|---|---|---|
| `es_extended` | ESX `getMoney` / `removeMoney` | `canCarryItem` / `addInventoryItem` |
| `qb-core` | QBCore cash | `AddItem`, plus `qb-inventory:CanAddItem` when present |
| `ox_inventory` | (unchanged) | takes over items outright, whatever the framework |
| nothing supported | built-in wallet | built-in item counts |

The built-in fallback persists to the server KVS, keyed on the player's account. It uses the
account id from `cfx.re/playerData.v1alpha1` (the `player-data` resource implements it) when
that resource is running, and the Rockstar `license:` identifier otherwise — both are stable
across reconnects. New players are seeded with `Config.Standalone.startingBalance`.

Items are granted under the ids in `Config.Items` (`water_bottle`, `water_sparkling`,
`water_pack`, `water_glacier`). On a framework server those ids must exist in its item
registry, or the grant fails and the player is automatically refunded.

## Configuration

Everything tunable lives in `config.lua`: counter locations, interaction distance, marker and
blip appearance, the catalogue with prices and per-purchase limits, restock interval, and the
abuse limits below. Prices are read from this file on the server for every charge, so editing
it is the only way to change what anything costs.

## Security model

The client may say *what* it wants and *how many*. Everything else is decided server-side.

- **Price** is read from `Config.Items` when charging; a price sent by a client is ignored.
- **Position** is read from the server's copy of the player's ped, so a client cannot buy from
  across the map. `Config.ServerDistanceTolerance` leaves room for replication lag.
- **Quantity** must be an integer within the item's `maxPerPurchase` — rejects `0`, negatives,
  fractions, `NaN`, infinities and strings.
- **Item id** must be in the catalogue; anything else is refused and logged.
- **Duplicate transactions**: each attempt carries a client-generated transaction id. A
  completed id is remembered for `txMemoryMs` and a repeat of it is answered from that record
  instead of being charged again, so a double-send, a retry or a replay all charge once.
- **Concurrency**: one purchase in flight per player, and a cooldown between completed
  purchases, so two requests arriving together cannot both succeed.
- **Rate limit**: a sliding window over all attempts, accepted or refused.
- **Order of operations**: capacity is checked, then money is taken, then the item is granted.
  A failed grant refunds and logs. Stock decrements only after the item is actually delivered.

Every completed purchase writes an audit line to the server console.

## Events

| Event | Direction | Payload |
|---|---|---|
| `water-shop:requestCatalog` | client → server | — |
| `water-shop:catalog` | server → client | `{ ok, message?, shopName, location, currency, moneyLabel, balance, items }` |
| `water-shop:purchase` | client → server | `txId, itemId, quantity` |
| `water-shop:purchaseResult` | server → client | `{ txId, ok, message, balance, items }` |

## NUI

`html/` is plain HTML/CSS/JS with no dependencies and no external requests. The layout is
sized in `rem` off a viewport-driven root font-size, so it scales as one piece from 720p to 4K
rather than being pinned to pixels; media queries handle only genuine shape changes (narrow,
short). It stays within the Chromium 103 feature set that FiveM's CEF provides — no container
queries, no `:has()`, no `dvh`.

Verified with no overflow or clipping at 800x600, 1024x768, 1280x720, 1600x540, 1920x1080,
2560x1080, 3440x1440 and 3840x2160, and in the stacked layout at 760x900.
