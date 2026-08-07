#!/usr/bin/env node
/**
 * Builds data/natives-index.json from the FiveM native reference.
 *
 *   node scripts/sync-natives.mjs [--offline]
 *
 * Two documents make up the reference: the GTA V natives and the CFX ones that
 * FiveM adds on top. Both are published as JSON keyed by namespace and then by
 * hash. What this script does with them is mostly name mangling -- the reference
 * calls a native SET_ENTITY_COORDS, the Lua runtime exposes it as
 * SetEntityCoords -- plus throwing away everything the checker does not need
 * (examples are the bulk of the source documents).
 *
 * The result is committed, so the tools work offline and a fresh clone does not
 * need network access. Re-run this after a FiveM update to pick up new natives.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { PACKAGE_ROOT } from "./lib.mjs";

const OUT_PATH = resolve(PACKAGE_ROOT, "data/natives-index.json");

const SOURCES = [
  { url: "https://runtime.fivem.net/doc/natives.json", label: "gta" },
  { url: "https://runtime.fivem.net/doc/natives_cfx.json", label: "cfx" },
];

/** Games other than GTA V that share the reference document. */
const FOREIGN_GAMES = new Set(["rdr3", "ny"]);

/**
 * The reference name in the runtime's spelling.
 *
 * Rules, all three confirmed against a running client:
 *   SET_ENTITY_COORDS          -> SetEntityCoords
 *   _FORCE_VEHICLE_ENGINE_SYNTH-> ForceVehicleEngineSynth  (leading _ dropped)
 *   GET_GROUND_Z_FOR_3D_COORD  -> GetGroundZFor_3dCoord    (underscore kept in
 *                                 front of a segment that starts with a digit)
 * Natives without a name are only reachable through their hash: N_0x + lowercase.
 */
export function toLuaName(refName, hash) {
  if (!refName) return `N_${String(hash).toLowerCase()}`;

  const stripped = refName.replace(/^_+/, "");
  if (/^0[xX][0-9a-fA-F]+$/.test(stripped)) return `N_${stripped.toLowerCase()}`;

  let out = "";
  for (const segment of stripped.split("_")) {
    if (segment.length === 0) continue;
    const pascal = segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase();
    // A segment starting with a digit keeps its separator, otherwise the name
    // would read GetGroundZFor3dCoord and no such global exists.
    out += /^[0-9]/.test(segment) && out.length > 0 ? `_${pascal}` : pascal;
  }
  return out;
}

/**
 * Where a native can be called, as a set.
 *
 * This has to be a set rather than one value: plenty of names appear in both
 * documents, once as a GTA client native and once as a CFX server native with
 * its own hash -- GetEntityCoords is both. Collapsing those to a single apiset
 * marks core client natives as server-only.
 *
 * The GTA document has no apiset field; those are game natives, so client.
 */
function apisetsOf(entry) {
  const apiset = entry.apiset;
  if (apiset === "shared") return ["client", "server"];
  if (apiset === "server" || apiset === "client") return [apiset];
  return ["client"];
}

const isClientCapable = (native) => native.apisets.includes("client");

/** Longest example worth carrying, and how many. Beyond this it is a tutorial. */
const EXAMPLE_CHARS = 1200;
const EXAMPLE_COUNT = 3;

/**
 * Working code for a native, straight out of its documentation.
 *
 * Worth the bytes: ~450 natives have one, and an example shows the calling
 * convention -- which arguments are floats, what the extra return values are --
 * far better than the signature alone.
 */
function examplesOf(entry) {
  return (entry.examples ?? [])
    .filter((example) => example && typeof example.code === "string" && example.code.trim())
    .slice(0, EXAMPLE_COUNT)
    .map((example) => ({
      lang: example.lang ?? "lua",
      code:
        example.code.length > EXAMPLE_CHARS
          ? `${example.code.slice(0, EXAMPLE_CHARS)}\n-- …`
          : example.code,
    }));
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status} ${response.statusText}`);
  }
  return response.json();
}

/** Cache next to the output so --offline can rebuild without the network. */
function cachePath(label) {
  return resolve(PACKAGE_ROOT, `data/.cache-natives-${label}.json`);
}

async function loadSource({ url, label }, offline) {
  if (offline) {
    console.log(`  ${label}: reading cache`);
    return JSON.parse(readFileSync(cachePath(label), "utf8"));
  }
  console.log(`  ${label}: GET ${url}`);
  const document = await fetchJson(url);
  mkdirSync(dirname(cachePath(label)), { recursive: true });
  writeFileSync(cachePath(label), JSON.stringify(document), "utf8");
  return document;
}

function collect(document, sourceLabel, natives, stats) {
  for (const [namespace, entries] of Object.entries(document)) {
    for (const [hash, entry] of Object.entries(entries)) {
      if (entry.game && FOREIGN_GAMES.has(entry.game)) {
        stats.skippedForeignGame += 1;
        continue;
      }

      const lua = toLuaName(entry.name, hash);
      const aliases = (entry.aliases ?? [])
        .map((alias) => toLuaName(alias, hash))
        .filter((alias) => alias !== lua);

      natives.push({
        lua,
        ref: entry.name ?? null,
        hash,
        ns: entry.ns ?? namespace,
        apisets: apisetsOf(entry),
        src: sourceLabel,
        params: (entry.params ?? []).map((param) => ({
          n: param.name,
          t: param.type,
          ...(param.description ? { d: param.description } : {}),
        })),
        results: entry.results ?? "void",
        ...(entry.description ? { desc: entry.description.trim() } : {}),
        ...(entry.resultsDescription ? { returns: entry.resultsDescription.trim() } : {}),
        ...(aliases.length > 0 ? { aliases } : {}),
        ...(examplesOf(entry).length > 0 ? { examples: examplesOf(entry) } : {}),
      });
    }
  }
}

async function main() {
  const offline = process.argv.includes("--offline");
  console.log(`Building native index${offline ? " (offline, from cache)" : ""}`);

  const natives = [];
  const stats = { skippedForeignGame: 0 };
  for (const source of SOURCES) {
    const document = await loadSource(source, offline);
    collect(document, source.label, natives, stats);
  }

  // Merge the entries that appear in both documents: union the apisets, and
  // describe the native with its client-side entry, because that is the one a
  // snippet actually calls. Its hash goes with it -- the two sides differ.
  const byLua = new Map();
  let merged = 0;
  for (const native of natives) {
    const existing = byLua.get(native.lua);
    if (!existing) {
      byLua.set(native.lua, native);
      continue;
    }

    merged += 1;
    const apisets = [...new Set([...existing.apisets, ...native.apisets])].sort();
    // Swap the base record only when the newcomer is the client-side one.
    const base = !isClientCapable(existing) && isClientCapable(native) ? native : existing;
    byLua.set(native.lua, { ...base, apisets });
  }

  const sorted = [...byLua.values()].sort((a, b) => a.lua.localeCompare(b.lua));
  const index = {
    generatedAt: new Date().toISOString(),
    sources: SOURCES.map((source) => source.url),
    count: sorted.length,
    natives: sorted,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(index), "utf8");

  const bySet = sorted.reduce((acc, native) => {
    const key = native.apisets.join("+");
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const unnamed = sorted.filter((native) => native.ref === null).length;

  console.log(`\nWrote ${OUT_PATH}`);
  console.log(`  natives:   ${sorted.length}`);
  console.log(`  apisets:   ${Object.entries(bySet).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`  hash-only: ${unnamed}`);
  console.log(`  merged across both documents: ${merged}`);
  console.log(`  skipped (other games): ${stats.skippedForeignGame}`);
}

// Importable for the mangling tests; only run when invoked directly.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(`\nsync-natives failed: ${err.message}`);
    process.exit(1);
  });
}
