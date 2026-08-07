/**
 * Minimal declarations for luaparse, which ships no types.
 *
 * Only the surface the native scanner touches is described: parse(), the
 * position-carrying node shape and the error luaparse throws on bad input.
 */
declare module "luaparse" {
  export interface LuaNode {
    type: string;
    loc?: {
      start: { line: number; column: number };
      end: { line: number; column: number };
    };
    [key: string]: unknown;
  }

  export interface ParseOptions {
    luaVersion?: "5.1" | "5.2" | "5.3" | "LuaJIT";
    locations?: boolean;
    comments?: boolean;
    scope?: boolean;
    ranges?: boolean;
  }

  /** luaparse throws this; `line` is 1-based and `index` a byte offset. */
  export interface LuaParseError extends Error {
    line?: number;
    index?: number;
    column?: number;
  }

  export function parse(input: string, options?: ParseOptions): LuaNode;

  const luaparse: { parse: typeof parse };
  export default luaparse;
}
