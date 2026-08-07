import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { log } from "../logger.js";

interface NativeParam {
  n: string;
  t: string;
  d?: string;
}

interface NativeExample {
  lang: string;
  code: string;
}

type Apiset = "client" | "server";

export interface NativeEntry {
  /** The name the Lua runtime exposes, e.g. SetEntityCoords. */
  lua: string;
  /** The reference name, e.g. SET_ENTITY_COORDS. null for hash-only natives. */
  ref: string | null;
  hash: string;
  ns: string;
  /**
   * Every context the name is callable from. A native can be in both: the two
   * sides are separate implementations with separate hashes, and `hash` is the
   * client one whenever there is one.
   */
  apisets: Apiset[];
  src: "gta" | "cfx";
  /**
   * Curated minimum argument count from data/optional-params.json, for natives
   * whose trailing parameters are optional in practice. Absent for the vast
   * majority, where the parameter list decides.
   */
  minArgs?: number;
  params: NativeParam[];
  results: string;
  desc?: string;
  returns?: string;
  aliases?: string[];
  examples?: NativeExample[];
}

/**
 * How much a hit in each part of a native's documentation counts.
 *
 * A query word in the name is nearly always what the caller meant; the same
 * word buried in an example is a weak signal, but a real one when nothing else
 * matches.
 */
const FIELD_WEIGHT = { name: 10, ns: 5, desc: 3, params: 2, example: 1 } as const;

interface NativeIndexFile {
  generatedAt: string;
  sources: string[];
  count: number;
  natives: NativeEntry[];
}

/**
 * The FiveM native reference, in the runtime's spelling.
 *
 * Built by scripts/sync-natives.mjs and read once at startup. Everything the
 * checker and fivem_native_info need is answered from the three maps below;
 * the fuzzy search walks the array and is only reached when a lookup misses.
 */
export class NativeCatalog {
  private readonly byLua = new Map<string, NativeEntry>();
  private readonly byLower = new Map<string, NativeEntry>();
  private readonly byHash = new Map<string, NativeEntry>();
  private readonly entries: NativeEntry[];
  /** Full-text index over every documented field; see buildIndex(). */
  private readonly index: Map<string, Map<number, number>>;
  /** First four characters -> index terms, for the shared-prefix expansion. */
  private readonly prefixes = new Map<string, string[]>();
  /** Words in each native's own name, for the name-precision factor. */
  private readonly nameTokens: number[];

  readonly generatedAt: string;

  private constructor(file: NativeIndexFile) {
    this.entries = file.natives;
    this.generatedAt = file.generatedAt;

    for (const entry of file.natives) {
      this.byLua.set(entry.lua, entry);
      this.byLower.set(entry.lua.toLowerCase(), entry);
      this.byHash.set(entry.hash.toLowerCase(), entry);
      if (entry.ref) this.byLower.set(entry.ref.toLowerCase(), entry);

      for (const alias of entry.aliases ?? []) {
        // Aliases never displace a primary name: two natives can share one.
        if (!this.byLua.has(alias)) this.byLua.set(alias, entry);
        const lower = alias.toLowerCase();
        if (!this.byLower.has(lower)) this.byLower.set(lower, entry);
      }
    }

    this.index = this.buildIndex();
    this.nameTokens = this.entries.map((entry) => Math.max(1, tokenise(entry.lua).size));
    for (const term of this.index.keys()) {
      if (term.length < 4) continue;
      const bucket = term.slice(0, 4);
      const existing = this.prefixes.get(bucket);
      if (existing) existing.push(term);
      else this.prefixes.set(bucket, [term]);
    }
  }

  /**
   * @returns null when the index file is missing or unreadable. Callers degrade
   *   to "cannot check" rather than failing -- a stale checkout should not stop
   *   someone from running a snippet.
   */
  static load(packageRoot: string, indexPath: string): NativeCatalog | null {
    const path = resolve(packageRoot, indexPath);
    try {
      const file = JSON.parse(readFileSync(path, "utf8")) as NativeIndexFile;
      if (!Array.isArray(file.natives) || file.natives.length === 0) {
        log.warn(`Native index at ${path} contains no natives; native checking is off`);
        return null;
      }
      log.info(`Native index: ${file.natives.length} natives (${path})`);
      const catalog = new NativeCatalog(file);
      catalog.applyOptionalParams(resolve(packageRoot, "data/optional-params.json"));
      return catalog;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const detail = code === "ENOENT" ? "file not found" : String(err);
      log.warn(
        `Native index at ${path} could not be read (${detail}). fivem_run_code will run ` +
          "without checking natives. Build it with: npm run natives:sync",
      );
      return null;
    }
  }

  /**
   * Overlays curated minimum argument counts (name -> count) onto the loaded
   * entries. A missing file is the normal case on a trimmed install; a broken
   * one costs only the overlay, never the catalog.
   */
  applyOptionalParams(path: string): void {
    let overlay: Record<string, unknown>;
    try {
      overlay = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") log.warn(`Optional-params overlay at ${path} could not be read: ${String(err)}`);
      return;
    }

    for (const [name, min] of Object.entries(overlay)) {
      if (name.startsWith("//") || typeof min !== "number" || !Number.isInteger(min) || min < 0) continue;
      const entry = this.byLua.get(name);
      if (!entry) {
        log.warn(`Optional-params overlay names "${name}", which is not in the native index`);
        continue;
      }
      // Never widen past what the reference allows; the overlay only lowers.
      entry.minArgs = Math.min(min, entry.params.length);
    }
  }

  get size(): number {
    return this.entries.length;
  }

  /** Every native in the index, for callers that want to count or scan. */
  get natives(): readonly NativeEntry[] {
    return this.entries;
  }

  /** Exact match on the runtime spelling, including aliases. */
  find(luaName: string): NativeEntry | null {
    return this.byLua.get(luaName) ?? null;
  }

  /** Case-insensitive, and also accepts the SCREAMING_SNAKE reference name. */
  findLoose(name: string): NativeEntry | null {
    return this.byLower.get(name.toLowerCase()) ?? null;
  }

  findByHash(hash: string): NativeEntry | null {
    return this.byHash.get(hash.toLowerCase()) ?? null;
  }

  /**
   * Nearest names for a miss, in three passes: a typo first, then a
   * half-remembered substring, then names built from the same words.
   *
   * The third pass is the one that matters for an invented name. Something like
   * SetControlValueNextFrame is nobody's typo -- no native is within editing
   * distance of it -- but it shares most of its words with the natives that do
   * exist, and those are what the caller should be looking at.
   */
  suggest(name: string, limit = 5): string[] {
    const needle = name.toLowerCase();
    const byDistance: Array<{ lua: string; score: number }> = [];

    for (const entry of this.entries) {
      const candidate = entry.lua.toLowerCase();
      // Cheap gate: a name far off in length is never a typo of this one.
      if (Math.abs(candidate.length - needle.length) > 6) continue;
      const distance = editDistance(needle, candidate, 6);
      if (distance <= 5) byDistance.push({ lua: entry.lua, score: distance });
    }
    if (byDistance.length > 0) return rank(byDistance, limit);

    const bySubstring: Array<{ lua: string; score: number }> = [];
    for (const entry of this.entries) {
      if (entry.lua.toLowerCase().includes(needle)) {
        bySubstring.push({ lua: entry.lua, score: entry.lua.length });
        if (bySubstring.length >= 40) break;
      }
    }
    if (bySubstring.length > 0) return rank(bySubstring, limit);

    const wanted = tokenise(name);
    if (wanted.size === 0) return [];

    const byTokens: Array<{ lua: string; score: number }> = [];
    for (const entry of this.entries) {
      const tokens = tokenise(entry.lua);
      let shared = 0;
      for (const token of tokens) if (wanted.has(token)) shared += 1;
      if (shared < Math.min(2, wanted.size)) continue;
      // Most words in common wins; among equals, prefer the tighter name so a
      // three-word match does not lose to something with ten extra words.
      byTokens.push({ lua: entry.lua, score: -shared * 100 + (tokens.size - shared) });
    }
    return rank(byTokens, limit);
  }

  /**
   * Keyword search across everything a native documents: its name, namespace,
   * description, parameter docs and examples.
   *
   * Ranked by how many of the query's words a native matches first, then by
   * where they matched. Requiring every word would answer nothing useful for a
   * question like "make a ped walk to coordinates", which is the case this is
   * for -- finding a native without already knowing its name.
   */
  search(query: string, limit: number): NativeEntry[] {
    const terms = [...tokenise(query)];
    if (terms.length === 0) return [];

    const scores = new Map<number, { score: number; matched: number; nameHits: number }>();

    for (const term of terms) {
      // One query word can reach several index words: its own spelling, the
      // stem it shares with them, and a handful of domain synonyms.
      const hit = new Set<number>();
      for (const { term: variant, penalty } of this.expand(term)) {
        const postings = this.index.get(variant);
        if (!postings) continue;
        // Rare words carry the query: "heading" should outrank "get".
        const idf = Math.log(1 + this.entries.length / postings.size);

        for (const [docId, weight] of postings) {
          const current = scores.get(docId) ?? { score: 0, matched: 0, nameHits: 0 };
          current.score += weight * idf * penalty;
          // However many variants matched, the query word matched once.
          if (!hit.has(docId)) {
            current.matched += 1;
            if (weight >= FIELD_WEIGHT.name) current.nameHits += 1;
            hit.add(docId);
          }
          scores.set(docId, current);
        }
      }
    }

    // Weighted relevance decides, with two corrections. Covering more of the
    // query is better, and so is being *about* the query: a name whose every
    // word the query used beats a sprawling one that merely contains them, so
    // "GetEntityCoords" does not lose to GetOffsetFromCoordAndHeadingInWorldCoords.
    const ranked = [...scores.entries()].map(([docId, hit]) => {
      const coverage = 0.5 + (0.5 * hit.matched) / terms.length;
      const precision = 1 + hit.nameHits / (this.nameTokens[docId] ?? 1);
      return { docId, final: hit.score * coverage * precision };
    });

    return ranked
      .sort(
        (a, b) =>
          b.final - a.final ||
          // Among equals prefer the tighter name: GetEntityCoords over
          // GetEntityCoordsWithoutOffset.
          (this.entries[a.docId]?.lua.length ?? 0) - (this.entries[b.docId]?.lua.length ?? 0),
      )
      .slice(0, limit)
      .map((hit) => this.entries[hit.docId])
      .filter((entry): entry is NativeEntry => entry !== undefined);
  }

  /**
   * The index words one query word should look for.
   *
   * Two mismatches are worth bridging, both seen on real questions. Natives are
   * named in abbreviations -- a question about "coordinates" has to reach
   * `Coord`, one about an "animation" has to reach `Anim` -- and the docs pick
   * one word where a caller might use another ("spawn" for `CreateVehicle`).
   * Neither is guesswork about meaning; both are matched below full weight.
   */
  private expand(term: string): Array<{ term: string; penalty: number }> {
    const out = [{ term, penalty: 1 }];
    const seen = new Set([term]);

    const push = (variant: string, penalty: number) => {
      if (seen.has(variant) || !this.index.has(variant)) return;
      seen.add(variant);
      out.push({ term: variant, penalty });
    };

    for (const synonym of SYNONYMS.get(term) ?? []) push(synonym, 0.8);

    // Shared-prefix words, which is where the abbreviations live. Four
    // characters is short enough for coord/anim and long enough that "set" does
    // not drag in every word beginning with s-e-t.
    if (term.length >= 4) {
      for (const candidate of this.prefixes.get(term.slice(0, 4)) ?? []) {
        if (candidate.startsWith(term) || term.startsWith(candidate)) push(candidate, 0.7);
      }
    }

    return out;
  }

  /**
   * Term -> (document -> accumulated field weight). Built once at load, which
   * costs a few tens of milliseconds and saves rescanning 7000 documents on
   * every query.
   */
  private buildIndex(): Map<string, Map<number, number>> {
    const index = new Map<string, Map<number, number>>();

    const add = (docId: number, text: string | undefined, weight: number) => {
      if (!text) return;
      for (const term of tokenise(text)) {
        let postings = index.get(term);
        if (!postings) {
          postings = new Map();
          index.set(term, postings);
        }
        // A term repeated within one field counts once at its field weight;
        // matching in two fields adds up.
        postings.set(docId, Math.max(postings.get(docId) ?? 0, weight));
      }
    };

    this.entries.forEach((entry, docId) => {
      add(docId, entry.lua, FIELD_WEIGHT.name);
      add(docId, entry.ref ?? undefined, FIELD_WEIGHT.name);
      add(docId, entry.ns, FIELD_WEIGHT.ns);
      // Prose only. A good few descriptions paste a whole enum in a fenced
      // block -- SetCustomMpHudColor lists 230 HUD colours -- and indexing that
      // makes the native an answer to every question those constants mention.
      // The block stays in the entry, it is useful to read, just not to search.
      add(docId, stripCodeBlocks(entry.desc), FIELD_WEIGHT.desc);
      add(docId, entry.returns, FIELD_WEIGHT.desc);
      for (const param of entry.params) {
        add(docId, param.n, FIELD_WEIGHT.params);
        add(docId, param.d, FIELD_WEIGHT.params);
      }
      for (const example of entry.examples ?? []) {
        add(docId, example.code, FIELD_WEIGHT.example);
      }
    });

    return index;
  }
}

/** Drops fenced code blocks, leaving the prose around them. */
function stripCodeBlocks(text: string | undefined): string {
  return text ? text.replace(/```[\s\S]*?(?:```|$)/g, " ") : "";
}

function rank(scored: Array<{ lua: string; score: number }>, limit: number): string[] {
  return scored
    .sort((a, b) => a.score - b.score || a.lua.localeCompare(b.lua))
    .slice(0, limit)
    .map((entry) => entry.lua);
}

/**
 * Words the documentation and a caller are likely to disagree on.
 *
 * Kept short and symmetric on purpose. This is not a thesaurus: every pair here
 * is one the FiveM docs actually split on, where the native is named with one
 * word and the obvious question uses the other.
 */
const SYNONYM_GROUPS = [
  ["create", "spawn"],
  ["delete", "remove", "destroy"],
  ["coord", "position", "location"],
  ["heading", "rotation"],
  ["velocity", "speed"],
  ["teleport", "warp"],
  ["health", "hp"],
  ["vehicle", "car"],
  ["weapon", "gun"],
];
// Deliberately absent: ped/player. They read as synonyms in English but name
// different things here -- a player is a participant, a ped is the character
// entity -- and both words are so common that pairing them buried the precise
// answer under every native mentioning the other.

const SYNONYMS = new Map<string, string[]>(
  SYNONYM_GROUPS.flatMap((group) =>
    group.map((word) => [word, group.filter((other) => other !== word)] as const),
  ),
);

/**
 * English function words, dropped from both the index and the query.
 *
 * Without this a question phrased as a question ("how much health does an
 * entity have") is dominated by whatever documents happen to contain "does" and
 * "have"; inverse document frequency alone does not sink them far enough.
 * Deliberately free of anything domain-bearing -- "get", "set" and "is" prefix
 * thousands of native names and have to stay searchable.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "was", "were", "are",
  "you", "your", "its", "it", "they", "them", "their", "there", "here",
  "how", "what", "when", "where", "which", "who", "why", "does", "did", "done",
  "have", "has", "had", "will", "would", "should", "could", "can", "may",
  "any", "all", "some", "much", "many", "more", "most", "than", "then",
  "but", "not", "into", "onto", "out", "off", "over", "under", "about",
  "want", "need", "make", "makes", "made", "use", "used", "using", "via",
  "one", "two", "also", "only", "just", "each", "other", "another", "same",
]);

/**
 * Splits text into search terms: SetEntityCoords -> set, entity, coords.
 *
 * Used for the full-text index, for queries and for the word-overlap
 * suggestions, so all three agree on what a word is.
 */
function tokenise(text: string): Set<string> {
  const parts = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length > 1 && !STOPWORDS.has(part));
  return new Set(parts);
}

/** Whether a snippet, which runs client-side, can call this at all. */
export function isClientCapable(entry: NativeEntry): boolean {
  return entry.apisets.includes("client");
}

/** Signature in the shape a snippet would call it, for tool output. */
export function formatSignature(entry: NativeEntry): string {
  const params = entry.params.map((param) => `${param.n}: ${param.t}`).join(", ");
  return `${entry.lua}(${params}) -> ${entry.results}`;
}

/**
 * Levenshtein, abandoned once every cell in a row exceeds `max`. The catalog
 * calls this ~7000 times per miss, so the early exit matters more than the
 * exact distance of far-apart strings.
 */
function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const value = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    const swap = previous;
    previous = current;
    current = swap;
  }

  return previous[b.length] ?? max + 1;
}
