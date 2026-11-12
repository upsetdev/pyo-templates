// The database extensions a template can ask for, by engine: the names in
// Pyo's catalog (pyo/crates/pyo-db-controller/extensions.json), both the
// ones Pyo turns on and the "additional" ones the app's role creates itself,
// and its KV modules ("kv" there).
//
// A copy, so this repository builds on its own. Keep it in step with Pyo's:
// `bun run validate` compares the two when the pyo repository is checked out
// next to this one (../pyo), and fails when they differ.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const EXTENSIONS: Record<"postgres" | "kv", readonly string[]> = {
  postgres: [
    "auto_explain", "autoinc", "bloom", "btree_gin", "btree_gist", "citext", "cube", "dblink",
    "dict_int", "dict_xsyn", "earthdistance", "fuzzystrmatch", "hstore", "insert_username",
    "intagg", "intarray", "isn", "lo", "ltree", "moddatetime", "pg_cron", "pg_hint_plan",
    "pg_partman", "pg_partman_bgw", "pg_prewarm", "pg_stat_statements", "pg_trgm", "pgaudit",
    "pgcrypto", "pgrowlocks", "postgres_fdw", "refint", "seg", "sslinfo", "tablefunc", "tcn",
    "timescaledb", "tsm_system_rows", "tsm_system_time", "unaccent", "uuid-ossp", "vector", "xml2",
  ],
  kv: ["valkey-json", "valkey-bloom", "valkey-search"],
};

/** Pyo's catalog next to this repository, by engine, or null when it isn't there. */
export function pyoExtensions(root: string): Record<"postgres" | "kv", string[]> | null {
  const path = join(root, "..", "pyo", "crates", "pyo-db-controller", "extensions.json");
  if (!existsSync(path)) return null;
  const { extensions = [], kv = [] } = JSON.parse(readFileSync(path, "utf8")) as {
    extensions?: { name: string }[];
    kv?: { name: string }[];
  };
  return { postgres: extensions.map((e) => e.name), kv: kv.map((e) => e.name) };
}

/** How the copy above differs from Pyo's catalog, as readable lines. */
export function extensionDrift(root: string): string[] {
  const pyo = pyoExtensions(root);
  if (!pyo) return [];
  const errors: string[] = [];
  for (const engine of ["postgres", "kv"] as const) {
    const ours = new Set(EXTENSIONS[engine]);
    const theirs = new Set(pyo[engine]);
    const missing = [...theirs].filter((n) => !ours.has(n)).sort();
    const extra = [...ours].filter((n) => !theirs.has(n)).sort();
    if (missing.length) errors.push(`${engine}: add ${missing.join(", ")} (in Pyo's catalog)`);
    if (extra.length) errors.push(`${engine}: remove ${extra.join(", ")} (not in Pyo's catalog)`);
  }
  return errors;
}
