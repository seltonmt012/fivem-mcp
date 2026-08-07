#!/usr/bin/env node
/**
 * Checks the native reference layer without needing FiveM: name mangling, the
 * scope-aware scanner, the catalog and the verdicts checkNatives() reaches.
 *
 *   npm run build && node scripts/check-natives.mjs
 *
 * The live probe is faked here. That it agrees with a real client was verified
 * against a running game -- 220 sampled names, no misses -- and is re-checkable
 * by pointing fivem_native_info at any of them.
 */
import { NativeCatalog } from "../dist/natives/catalog.js";
import { scanForNativeCalls } from "../dist/natives/scanCode.js";
import { buildProbeSnippet, checkNatives } from "../dist/security/nativeCheck.js";
import { check, finish, PACKAGE_ROOT, section } from "./lib.mjs";
import { toLuaName } from "./sync-natives.mjs";

/** A probe that knows exactly the names it was given, and nothing else. */
function fakeProbe(present) {
  return async (names) => new Map(names.map((name) => [name, present.includes(name)]));
}

const errorsOf = (report) => report.issues.filter((issue) => issue.severity === "error");
const warningsOf = (report) => report.issues.filter((issue) => issue.severity === "warning");
const named = (report, name) => report.issues.find((issue) => issue.name === name);

async function main() {
  section("Name mangling");
  check("SET_ENTITY_COORDS -> SetEntityCoords", toLuaName("SET_ENTITY_COORDS", "0x0") === "SetEntityCoords");
  check(
    "leading underscore is dropped",
    toLuaName("_FORCE_VEHICLE_ENGINE_SYNTH", "0x0") === "ForceVehicleEngineSynth",
  );
  check(
    "digit segment keeps its separator",
    toLuaName("GET_GROUND_Z_FOR_3D_COORD", "0x0") === "GetGroundZFor_3dCoord",
    toLuaName("GET_GROUND_Z_FOR_3D_COORD", "0x0"),
  );
  check(
    "trailing digit segment keeps its separator",
    toLuaName("SET_PLAYER_WEAPON_DEFENSE_MODIFIER_2", "0x0") === "SetPlayerWeaponDefenseModifier_2",
  );
  check(
    "nameless natives become N_0x + lowercase",
    toLuaName(null, "0x153973AB99FE8980") === "N_0x153973ab99fe8980",
  );

  section("Catalog");
  const catalog = NativeCatalog.load(PACKAGE_ROOT, "data/natives-index.json");
  if (!catalog) {
    console.log("  FAIL  index missing -- run: npm run natives:sync");
    process.exit(1);
  }
  check("index has a plausible size", catalog.size > 6000, `${catalog.size}`);
  check("finds a native by runtime name", catalog.find("SetEntityCoords")?.hash === "0x06843DA7060A026B");
  check("finds it by reference name", catalog.findLoose("SET_ENTITY_COORDS")?.lua === "SetEntityCoords");
  check("finds it case-insensitively", catalog.findLoose("setentitycoords")?.lua === "SetEntityCoords");
  check("finds it by hash", catalog.findByHash("0x06843da7060a026b")?.lua === "SetEntityCoords");
  check(
    "knows a server-only native",
    catalog.find("DropPlayer")?.apisets.join() === "server",
    catalog.find("DropPlayer")?.apisets.join(),
  );
  check(
    "keeps both apisets for a native that has two sides",
    catalog.find("GetEntityCoords")?.apisets.join() === "client,server",
    catalog.find("GetEntityCoords")?.apisets.join(),
  );
  check(
    "and describes it with its client-side entry",
    catalog.find("GetEntityCoords")?.hash === "0x3FEF770D40960D5A",
    catalog.find("GetEntityCoords")?.hash,
  );
  check(
    "suggests the real name for a typo",
    catalog.suggest("SetEntityCoord").includes("SetEntityCoords"),
    catalog.suggest("SetEntityCoord").join(","),
  );
  check(
    "keyword search ranks the exact name first",
    catalog.search("GetEntityCoords", 5)[0]?.lua === "GetEntityCoords",
    catalog.search("GetEntityCoords", 5)[0]?.lua,
  );

  section("Search");
  const found = (query, name, depth = 5) =>
    catalog.search(query, depth).some((entry) => entry.lua === name);

  // The point of indexing descriptions: finding a native without its name.
  check("finds a native by what it does", found("spawn a vehicle", "CreateVehicle"));
  check(
    "matches words only in the description",
    found("how much health does an entity have", "GetEntityHealth"),
  );
  check("handles a question phrased as one", found("which street am i on", "GetStreetNameAtCoord"));
  check("finds it by intent, not name", found("freeze entity in place", "FreezeEntityPosition"));
  // Abbreviated names: the query says coordinates, the native says Coord.
  check("bridges an abbreviation", found("ground height at position", "GetGroundZFor_3dCoord"));
  check("bridges a synonym", catalog.search("spawn a vehicle", 3)[0]?.lua === "CreateVehicle");
  check("empty query returns nothing", catalog.search("   ", 5).length === 0);
  check(
    "a description enum dump does not swamp the index",
    !found("teleport the player", "SetCustomMpHudColor"),
  );

  section("Examples");
  // Attached to the native they document, not merely present somewhere.
  const documented = catalog.find("GetGroundZFor_3dCoord");
  check("examples survive into the index", (documented?.examples?.length ?? 0) > 0);
  check(
    "and are attached to the right native",
    documented?.examples?.[0]?.code.includes("GetGroundZFor_3dCoord") === true,
    documented?.examples?.[0]?.code.slice(0, 80),
  );
  check(
    "the corpus keeps roughly all of them",
    catalog.natives.filter((entry) => (entry.examples?.length ?? 0) > 0).length > 400,
  );
  // An invented name is nobody's typo, so the word-overlap pass has to carry it.
  check(
    "suggests same-word natives for an invented name",
    catalog.suggest("SetControlValueNextFrame").includes("SetControlNormal"),
    catalog.suggest("SetControlValueNextFrame").join(","),
  );
  check(
    "and points at the real melee task native",
    catalog.suggest("TaskMeleeAttackPed").includes("TaskPutPedDirectlyIntoMelee"),
    catalog.suggest("TaskMeleeAttackPed").join(","),
  );

  section("Scanner");
  const scan = (code) => scanForNativeCalls(code).calls.map((call) => call.name);

  check("finds a plain native call", scan("PlayerPedId()").includes("PlayerPedId"));
  check(
    "ignores locals",
    !scan("local helper = function() end\nhelper()").includes("helper"),
  );
  check(
    "ignores local functions",
    !scan("local function helper() end\nhelper()").includes("helper"),
  );
  check(
    "ignores globals the snippet defines",
    !scan("function helper() end\nhelper()").includes("helper"),
  );
  check(
    "ignores assigned globals",
    !scan("helper = function() end\nhelper()").includes("helper"),
  );
  check("ignores function parameters", !scan("local f = function(cb) cb() end").includes("cb"));
  check(
    "ignores loop variables",
    !scan("for _, fn in ipairs(t) do fn() end").includes("fn"),
  );
  check("ignores member calls", scan("ctx.thread(function() end)").length === 0);
  check("ignores method calls", scan("local o = {} o:run()").length === 0);
  check("ignores the Lua standard library", scan("print(tostring(1))").length === 0);
  check("ignores runtime globals", scan("Wait(0) CreateThread(function() end)").length === 0);
  check(
    "sees through a thread body",
    scan("ctx.thread(function() SetEntityCoords(1) end)").includes("SetEntityCoords"),
  );
  check(
    "records the argument count",
    scanForNativeCalls("TaskCombatPed(a, b, c, d)").calls[0]?.args === 4,
  );
  check(
    "a snippet that does not parse reports the failure",
    scanForNativeCalls("local x = ").ok === false,
  );
  // `repeat ... until cond` evaluates its condition inside the body's scope.
  // Getting this wrong made strict mode reject valid Lua.
  check(
    "a repeat-until condition sees the body's locals",
    !scan("repeat local f = mk() until f()").includes("f"),
    scan("repeat local f = mk() until f()").join(","),
  );
  check(
    "and still reports the unknown call inside it",
    scan("repeat local f = mk() until f()").includes("mk"),
  );
  check("a local does not escape its block", scan("do local h = mk() end h()").includes("h"));
  // Fails loudly if anyone wires ownGlobals to luaparse's chunk.globals, which
  // lists every free identifier and would disable the checker entirely.
  check(
    "an undeclared call is not excused as a global the snippet defines",
    scan("helper = 1\nSetEntityCoords(t)").includes("SetEntityCoords"),
  );
  const argsOf = (code) => scanForNativeCalls(code).calls[0]?.args;
  check(
    "an expanding last argument suppresses the arity guess",
    argsOf("SetEntityCoords(table.unpack(t))") === -1,
    String(argsOf("SetEntityCoords(table.unpack(t))")),
  );
  check("so does a trailing ...", argsOf("SetEntityCoords(...)") === -1);
  check(
    "but a call in a non-final position still counts as one argument",
    scanForNativeCalls("TaskCombatPed(GetPlayerPed(), b, c, d)").calls.find(
      (call) => call.name === "TaskCombatPed",
    )?.args === 4,
  );

  section("Probe snippet");
  const probeSnippet = buildProbeSnippet(["PlayerPedId", "bad name", "SetEntityCoords"]);
  check("quotes valid identifiers", probeSnippet.includes('"PlayerPedId"'));
  check("drops anything that is not an identifier", !probeSnippet.includes("bad name"));

  section("Verdicts");

  const clean = await checkNatives(
    "local ped = PlayerPedId()\nlocal c = GetEntityCoords(ped)\nreturn c.x",
    catalog,
    "strict",
    fakeProbe(["PlayerPedId", "GetEntityCoords"]),
  );
  check("a correct snippet passes", errorsOf(clean).length === 0, JSON.stringify(clean.issues));
  check("and reports what it checked", clean.checked === 2 && clean.probed === true);

  // The mistake that motivated all of this: plausible name, no such native.
  const invented = await checkNatives(
    "SetControlValueNextFrame(0, 24, 1.0)",
    catalog,
    "strict",
    fakeProbe([]),
  );
  check(
    "an invented native is rejected",
    named(invented, "SetControlValueNextFrame")?.kind === "unknown",
  );

  const serverSide = await checkNatives('DropPlayer(1, "bye")', catalog, "strict", fakeProbe([]));
  check("a server-side native is rejected", named(serverSide, "DropPlayer")?.kind === "server-only");

  // A native with both sides must not be rejected just because a server one exists.
  const bothSides = await checkNatives(
    "GetEntityCoords(PlayerPedId())",
    catalog,
    "strict",
    fakeProbe(["GetEntityCoords", "PlayerPedId"]),
  );
  check("a native with both sides passes client-side", errorsOf(bothSides).length === 0);

  const notInBuild = await checkNatives("SetEntityCoords(1)", catalog, "strict", fakeProbe([]));
  check(
    "documented but absent from the client is rejected",
    named(notInBuild, "SetEntityCoords")?.kind === "missing-at-runtime",
  );

  const undocumented = await checkNatives(
    "SomeOtherResourceGlobal()",
    catalog,
    "strict",
    fakeProbe(["SomeOtherResourceGlobal"]),
  );
  check(
    "an undocumented global the client does have is accepted",
    errorsOf(undocumented).length === 0,
  );

  const typo = await checkNatives("SetEntityCoordss(1)", catalog, "strict", fakeProbe([]));
  check(
    "a typo comes back with the right name",
    named(typo, "SetEntityCoordss")?.suggestions?.includes("SetEntityCoords") === true,
    JSON.stringify(named(typo, "SetEntityCoordss")?.suggestions),
  );

  const wrongCase = await checkNatives("setentitycoords(1)", catalog, "strict", fakeProbe([]));
  check(
    "wrong casing is named as such",
    named(wrongCase, "setentitycoords")?.detail.includes("SetEntityCoords") === true,
  );

  // GET_GROUND_Z_FOR_3D_COORD: 5 params, one of them an output float*.
  const arity = await checkNatives(
    "GetGroundZFor_3dCoord(1.0, 2.0, 3.0, false)",
    catalog,
    "strict",
    fakeProbe(["GetGroundZFor_3dCoord"]),
  );
  check(
    "omitting an output parameter is not flagged",
    arity.issues.length === 0,
    JSON.stringify(arity.issues),
  );

  const tooMany = await checkNatives(
    "PlayerPedId(1, 2, 3)",
    catalog,
    "strict",
    fakeProbe(["PlayerPedId"]),
  );
  check("too many arguments warns", warningsOf(tooMany).length === 1);
  check("but does not block", errorsOf(tooMany).length === 0);

  const spread = await checkNatives(
    "SetEntityCoords(table.unpack(t))",
    catalog,
    "strict",
    fakeProbe(["SetEntityCoords"]),
  );
  check("a spread call raises no arity warning", spread.issues.length === 0, JSON.stringify(spread.issues));

  const off = await checkNatives("Whatever()", catalog, "off", fakeProbe([]));
  check('mode "off" skips everything', off.issues.length === 0 && Boolean(off.skipped));

  const noIndex = await checkNatives("Whatever()", null, "strict", fakeProbe([]));
  check("a missing index does not block a snippet", noIndex.issues.length === 0 && Boolean(noIndex.skipped));

  const unparseable = await checkNatives("local x = ", catalog, "strict", fakeProbe([]));
  check(
    "an unparseable snippet is left to the game",
    unparseable.issues.length === 0 && Boolean(unparseable.skipped),
  );

  const noProbe = await checkNatives("SetEntityCoords(1)", catalog, "strict", null);
  check(
    "without a client the reference alone decides",
    noProbe.probed === false && errorsOf(noProbe).length === 0,
  );

  section("No false positives on the snippets this session ran");
  const realSnippets = [
    'local ctx = ...\nlocal ped = PlayerPedId()\nlocal c = GetEntityCoords(ped)\nlocal h = GetEntityHeading(ped)\nlocal street, cross = GetStreetNameAtCoord(c.x, c.y, c.z)\nlocal zone = GetNameOfZone(c.x, c.y, c.z)\nreturn { street = GetStreetNameFromHashKey(street), zone = GetLabelText(zone), veh = GetVehiclePedIsIn(ped, false), interior = GetInteriorFromEntity(ped) }',
    'local ctx = ...\nlocal ped = PlayerPedId()\nlocal t = GetOffsetFromEntityInWorldCoords(ped, 0.0, 10.0, 0.0)\nlocal found, gz = GetGroundZFor_3dCoord(t.x, t.y, t.z + 2.0, false)\nctx.thread(function()\n  TaskGoStraightToCoord(ped, t.x, t.y, gz, 1.0, 15000, GetEntityHeading(ped), 0.5)\n  while ctx.alive() do Citizen.Wait(200) end\nend)\nreturn true',
    'local ctx = ...\nlocal ped = PlayerPedId()\nfor _, p in ipairs(GetGamePool("CPed")) do\n  if p ~= ped and DoesEntityExist(p) then\n    local c = GetEntityCoords(p)\n    if #(c - GetEntityCoords(ped)) < 60.0 then\n      local m = GetEntityModel(p)\n    end\n  end\nend\nreturn GetHashKey("a_c_cow")',
    'local ctx = ...\nlocal ped, cow = PlayerPedId(), 4354\nSetCurrentPedWeapon(ped, GetHashKey("WEAPON_UNARMED"), true)\nRequestAnimDict("melee@unarmed@streamed_core")\nctx.thread(function()\n  while not HasAnimDictLoaded("melee@unarmed@streamed_core") do Citizen.Wait(20) end\n  SetEntityHeading(ped, GetHeadingFromVector_2d(1.0, 2.0))\n  TaskPlayAnim(ped, "d", "a", 8.0, -8.0, -1, 0, 0.0, false, false, false)\n  ApplyDamageToPed(cow, 60, false)\n  ClearPedTasks(ped)\n  if IsPedDeadOrDying(cow, true) then ctx.log("down") end\nend)\nreturn GetEntityHealth(cow)',
  ];

  for (const [i, snippet] of realSnippets.entries()) {
    const report = await checkNatives(snippet, catalog, "warn", null);
    const bad = errorsOf(report);
    check(
      `snippet ${i + 1} resolves cleanly (${report.checked} natives)`,
      bad.length === 0,
      bad.map((issue) => `${issue.name}: ${issue.detail}`).join(" | "),
    );
  }

  finish();
}

main().catch((err) => {
  console.error("check-natives crashed:", err);
  process.exit(1);
});
