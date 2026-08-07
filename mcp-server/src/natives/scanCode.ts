import luaparse, { type LuaNode, type LuaParseError } from "luaparse";

export interface CallSite {
  /** Identifier as written in the snippet. */
  name: string;
  line: number;
  /**
   * Argument count at this call site, or -1 when it cannot be known: a call or
   * `...` in final position expands to however many values it returns.
   */
  args: number;
}

export type ScanResult =
  | { ok: true; calls: CallSite[] }
  | { ok: false; error: string; line: number | null };

/**
 * The raw scan of one chunk, for callers that combine several files: calls are
 * filtered of runtime globals but NOT of the chunk's own globals, and the
 * globals the chunk defines come along -- a resource-wide check unions them
 * across files before filtering, so a helper defined in one file covers a call
 * in another.
 */
export type ChunkScanResult =
  | { ok: true; calls: CallSite[]; ownGlobals: Set<string> }
  | { ok: false; error: string; line: number | null };

/**
 * Globals the Lua runtime provides that are not natives and therefore never
 * appear in the reference. Everything else called as a bare identifier has to
 * resolve to a native -- or to something the snippet defined itself, which the
 * scope tracking below takes care of.
 *
 * Kept deliberately short: a global that is missing here and not a native gets
 * checked against the live client, which is the better answer anyway. This list
 * only matters when no game is connected.
 */
const RUNTIME_GLOBALS = new Set([
  // Lua standard library
  "assert", "collectgarbage", "dofile", "error", "getmetatable", "ipairs", "load",
  "loadfile", "loadstring", "next", "pairs", "pcall", "print", "rawequal", "rawget",
  "rawlen", "rawset", "require", "select", "setmetatable", "tonumber", "tostring",
  "type", "unpack", "xpcall",
  // CitizenFX runtime
  "Citizen", "CreateThread", "CreateThreadNow", "Wait", "SetTimeout", "SetInterval",
  "ClearInterval", "exports", "json", "msgpack", "promise", "Cfx", "Global", "GlobalState",
  "LocalPlayer", "Entity", "Player", "PlayerData", "source",
  // Event and NUI API the runtime provides as plain Lua functions. These are
  // not natives and never appear in the reference, but every resource uses
  // them -- without this list a resource lint with no client to probe flags
  // each one as an invented native.
  "AddEventHandler", "RemoveEventHandler", "RegisterNetEvent", "RegisterServerEvent",
  "TriggerEvent", "TriggerServerEvent", "TriggerClientEvent",
  "TriggerLatentServerEvent", "TriggerLatentClientEvent",
  "SendNUIMessage", "RegisterNUICallback", "RegisterRawNuiCallback", "PerformHttpRequest",
  // glm bindings the runtime installs
  "vec", "vec2", "vec3", "vec4", "vector2", "vector3", "vector4",
  "ivec", "ivec1", "ivec2", "ivec3", "ivec4", "quat", "qua",
  "mat2", "mat3", "mat4", "mat2x2", "mat2x3", "mat2x4", "mat3x2", "mat3x3",
  "mat3x4", "mat4x2", "mat4x3", "mat4x4",
  "dot", "cross", "norm", "normalize", "length", "distance", "absf", "reflect",
]);

interface ScanState {
  calls: CallSite[];
  /** Globals the snippet assigns itself (`function helper()` / `helper = ...`). */
  ownGlobals: Set<string>;
}

/**
 * Finds every bare-identifier call in a snippet that could be a native.
 *
 * Method and member calls (`ctx.thread(...)`, `obj:method()`) are ignored: their
 * base is a MemberExpression rather than an Identifier, so they never reach the
 * check at all.
 *
 * Scope comes from luaparse: with `scope: true` every Identifier carries
 * `isLocal`, which covers locals, function parameters and loop variables. Doing
 * that by hand is easy to get subtly wrong -- `repeat ... until cond` evaluates
 * its condition *inside* the body's scope, so a hand-rolled stack that pops
 * before the condition reports the body's locals as unknown natives and the
 * snippet gets rejected.
 */
export function scanForNativeCalls(code: string): ScanResult {
  const scan = scanChunk(code);
  if (!scan.ok) return scan;
  // Filtering afterwards rather than during the walk keeps it order-independent:
  // a helper defined at the bottom still covers a call at the top.
  return { ok: true, calls: scan.calls.filter((call) => !scan.ownGlobals.has(call.name)) };
}

/** The scan behind scanForNativeCalls, with the chunk's own globals unapplied. */
export function scanChunk(code: string): ChunkScanResult {
  let ast: LuaNode;
  try {
    // 5.3 matches what check-resource.mjs uses for the resource's own Lua.
    ast = luaparse.parse(code, {
      luaVersion: "5.3",
      locations: true,
      comments: false,
      scope: true,
    });
  } catch (err) {
    const parseError = err as LuaParseError;
    return {
      ok: false,
      error: parseError.message ?? String(err),
      line: typeof parseError.line === "number" ? parseError.line : null,
    };
  }

  const state: ScanState = { calls: [], ownGlobals: new Set() };
  walk(ast, state);

  return {
    ok: true,
    calls: state.calls.filter((call) => !RUNTIME_GLOBALS.has(call.name)),
    ownGlobals: state.ownGlobals,
  };
}

function lineOf(node: LuaNode): number {
  return node.loc?.start.line ?? 0;
}

function isNode(value: unknown): value is LuaNode {
  return typeof value === "object" && value !== null && typeof (value as LuaNode).type === "string";
}

function children(node: LuaNode): LuaNode[] {
  const out: LuaNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    // `scope: true` hangs a `globals` array off the Chunk holding Identifier
    // nodes that are already in the tree; walking it would visit them twice.
    if (key === "globals") continue;
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) out.push(item);
    } else if (isNode(value)) {
      out.push(value);
    }
  }
  return out;
}

/** Depth-first, so call sites come out in source order. */
function walk(node: LuaNode, state: ScanState): void {
  switch (node.type) {
    case "CallExpression":
    case "StringCallExpression":
    case "TableCallExpression": {
      const base = node["base"];
      if (isNode(base) && base.type === "Identifier" && base["isLocal"] !== true) {
        state.calls.push({
          name: String(base["name"]),
          line: lineOf(node),
          args: countArguments(node),
        });
      }
      break;
    }

    case "AssignmentStatement": {
      for (const target of asArray(node["variables"])) {
        // `!== true` like the call-base check above: an identifier luaparse did
        // not mark as local is treated as a global either way.
        if (target.type === "Identifier" && target["isLocal"] !== true) {
          state.ownGlobals.add(String(target["name"]));
        }
      }
      break;
    }

    case "FunctionDeclaration": {
      // `function a.b.c()` carries a MemberExpression, which is never a call
      // base, so only the plain-identifier form matters here.
      const identifier = node["identifier"];
      if (node["isLocal"] !== true && isNode(identifier) && identifier.type === "Identifier") {
        state.ownGlobals.add(String(identifier["name"]));
      }
      break;
    }

    default:
      break;
  }

  for (const child of children(node)) walk(child, state);
}

function asArray(value: unknown): LuaNode[] {
  return Array.isArray(value) ? value.filter(isNode) : [];
}

function callArguments(node: LuaNode): LuaNode[] {
  if (node.type === "CallExpression") return asArray(node["arguments"]);
  // `f "str"` and `f { ... }` carry a single argument under a different key.
  const single = node.type === "StringCallExpression" ? node["argument"] : node["arguments"];
  return isNode(single) ? [single] : asArray(single);
}

/**
 * Lua expands a call or `...` in the last argument position to all of its
 * values, so `SetEntityCoords(table.unpack(t))` passes however many `t` holds,
 * not one. Anywhere else it is truncated to a single value and still counts as
 * one. -1 means "do not guess".
 */
function countArguments(node: LuaNode): number {
  const args = callArguments(node);
  const last = args[args.length - 1];
  if (last && (last.type === "VarargLiteral" || isCall(last))) return -1;
  return args.length;
}

function isCall(node: LuaNode): boolean {
  return (
    node.type === "CallExpression" ||
    node.type === "StringCallExpression" ||
    node.type === "TableCallExpression"
  );
}
