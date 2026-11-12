// Reading and checking templates. Everything here is shared by the validator,
// the build and the tests.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { parse } from "yaml";
import schema from "../template.schema.json";
import { composeToTemplate } from "./compose";
import { EXTENSIONS } from "./extensions";

export const ROOT = new URL("..", import.meta.url).pathname;
export const TEMPLATES_DIR = join(ROOT, "templates");

export type Source = { type: "image"; image: string; versions: { tag: string; digest: string }[] };

/** A service deployed next to a template's own (Plausible's ClickHouse). */
export type Companion = {
  name: string;
  image: string;
  version: { tag: string; digest: string };
  workload: "Deployment" | "StatefulSet";
  stateful: boolean;
  replicas: number;
  resources: Record<string, number>;
  args?: string[];
  entrypoint?: string[];
  storage?: { required: boolean; sizeGi: number; mountPath: string };
  ports: Template["ports"];
  healthCheck: Template["healthCheck"];
  env: { key: string; value: string }[];
};

export type Template = {
  id: string;
  name: string;
  description: string;
  category: string;
  logo?: string;
  tier: "official" | "community";
  author: string;
  homepage?: string;
  /** The template's own version (semver); Pyo records it with each service. */
  version: string;
  /** The app's version that the default image tag runs. */
  appVersion?: string;
  /** Reserved for upgrades; Pyo doesn't read it yet. */
  upgrade?: { breaking?: boolean; upgradeFrom?: string; notes?: string };
  minPyoVersion: string;
  source: Source;
  kind: string;
  workload: string;
  stateful: boolean;
  replicas: number;
  resources: Record<string, number>;
  gpu?: { use: "optional" | "required"; count: number };
  args?: string[];
  entrypoint?: string[];
  storage?: { required: boolean; sizeGi: number; mountPath: string };
  ports: { name: string; port: number; protocol: string; exposure: string }[];
  healthCheck: {
    type: string;
    path?: string;
    port?: number;
    command?: string;
    initialDelaySeconds: number;
    periodSeconds: number;
  };
  env: { key: string; value?: string; secret?: boolean; generate?: boolean; format?: "long" | "hex-32" | "base64-32"; prefix?: string }[];
  fields: {
    key: string;
    label: string;
    type: string;
    default?: string | number | boolean;
    options?: string[];
    required: boolean;
    sensitive?: boolean;
    envKey?: string;
    help?: string;
  }[];
  hints: string[];
  /** Databases it needs, at most one per engine. */
  databases?: Database[];
  featured?: boolean;
  hidden?: boolean;
  companions?: Companion[];
};

export type Database = {
  engine: keyof typeof DATABASE_VARIABLES;
  env: Record<string, string>;
  /** Extensions it needs, from Pyo's catalog (scripts/extensions.ts). */
  extensions?: string[];
};

/**
 * What each database engine offers a template's service: its Connect values,
 * plus the parts of its address for apps that want them one by one.
 */
export const DATABASE_VARIABLES = {
  mysql: ["DATABASE_URL", "MYSQL_HOST", "MYSQL_PORT", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE"],
  // DATABASE_URL goes through the pooler (transaction mode) when it's on;
  // DATABASE_URL_DIRECT and the POSTGRES_* parts never do: for migrations,
  // prepared statements and other session features.
  postgres: ["DATABASE_URL", "DATABASE_URL_DIRECT", "POSTGRES_HOST", "POSTGRES_PORT", "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DATABASE"],
  // Through pyo-kv, which follows failover.
  kv: ["REDIS_URL", "REDIS_HOST", "REDIS_PORT", "REDIS_PASSWORD"],
} as const;

/** Registries a template can pull from: public, and able to give a digest. */
export const REGISTRIES = [
  "docker.io",
  "ghcr.io",
  "quay.io",
  "registry.k8s.io",
  "registry.gitlab.com",
  "mcr.microsoft.com",
  "public.ecr.aws",
  "data.forgejo.org",
];

const MAX_FILE = 64 * 1024;
const MAX_LOGO = 16 * 1024;

/**
 * Templates come from strangers, so aliases are refused outright (they're how
 * YAML "bombs" expand a small file into gigabytes), and so are duplicate keys.
 */
export function parseTemplate(text: string): unknown {
  if (text.length > MAX_FILE) throw new Error("file is over 64 KB");
  return parse(text, { maxAliasCount: 0, uniqueKeys: true, merge: false });
}

const validateSchema = new Ajv({ allErrors: true, allowUnionTypes: true }).compile(schema);

function schemaErrors(raw: unknown) {
  if (validateSchema(raw)) return [];
  return (validateSchema.errors ?? [])
    // oneOf repeats each branch's complaint; the summary below says enough.
    .filter((e) => !e.schemaPath.includes("/oneOf/"))
    .map((e) => {
      const at = e.instancePath.replace(/^\//, "").replaceAll("/", ".") || "template";
      const extra = (e.params as { additionalProperty?: string }).additionalProperty;
      return extra ? `${at}: "${extra}" isn't allowed` : `${at}: ${e.message}`;
    });
}

/** Rules a JSON schema can't say. Assumes the schema passed. */
function ruleErrors(t: Template, folder: string) {
  const errors: string[] = [];
  const fail = (message: string) => errors.push(message);

  if (t.id !== folder) fail(`id "${t.id}" must match its folder "${folder}"`);
  if (t.tier === "official" && t.author !== "upsetdev")
    fail('official templates have author "upsetdev"');

  const s = t.source;
  const registryOk = (image: string, at: string) => {
    const registry = image.split("/")[0];
    if (!REGISTRIES.includes(registry))
      fail(`${at}: "${registry}" isn't an allowed registry (${REGISTRIES.join(", ")})`);
  };
  registryOk(s.image, "image");
  const tags = s.versions.map((v) => v.tag);
  if (new Set(tags).size !== tags.length) fail("versions: a tag is repeated");
  if (tags.some((tag) => tag === "latest")) fail('versions: use a real version, not "latest"');
  for (const c of t.companions ?? []) {
    registryOk(c.image, `services.${c.name}.image`);
    if (c.version.tag === "latest") fail(`services.${c.name}.image: use a real version, not "latest"`);
    if (c.stateful && c.replicas > 1) fail(`services.${c.name}: stateful services run one replica`);
    if (c.resources.cpuRequest > c.resources.cpuLimit) fail(`services.${c.name}: cpu reservation is over its limit`);
    if (c.resources.memoryRequest > c.resources.memoryLimit) fail(`services.${c.name}: memory reservation is over its limit`);
    for (const e of c.env)
      if (/pass(word|wd)?$|secret|api_?key|private_?key/i.test(e.key) && e.value)
        fail(`services.${c.name}.environment.${e.key}: looks like a secret; a companion can't have one`);
  }
  const names = (t.companions ?? []).map((c) => c.name);
  if (new Set(names).size !== names.length) fail("services: a name is repeated");

  const { resources: r, healthCheck: h } = t;
  if (r.cpuRequest > r.cpuLimit) fail("resources: cpuRequest is over cpuLimit");
  if (r.memoryRequest > r.memoryLimit) fail("resources: memoryRequest is over memoryLimit");

  if (t.stateful && t.replicas > 1) fail("stateful templates run one replica");
  if (t.stateful && !t.storage) fail("stateful templates need storage");

  if (h.type === "http" && !h.path?.startsWith("/")) fail("healthCheck: http needs a path");
  if (h.type === "tcp" && !h.port) fail("healthCheck: tcp needs a port");
  if (h.type === "exec" && !h.command) fail("healthCheck: exec needs a command");

  const keys = t.env.map((e) => e.key);
  if (new Set(keys).size !== keys.length) fail("env: a key is repeated");

  const portNames = t.ports.map((p) => p.name);
  if (new Set(portNames).size !== portNames.length) fail("ports: a name is repeated");

  const sensitive = new Set(t.fields.filter((f) => f.sensitive).map((f) => f.envKey));
  for (const e of t.env) {
    if (e.secret && e.value) fail(`env.${e.key}: a secret can't have a value in the template`);
    if (e.secret && !e.generate && !sensitive.has(e.key))
      fail(`env.${e.key}: a secret needs generate: true or a sensitive field`);
    if (!e.secret && /pass(word|wd)?$|secret|api_?key|private_?key/i.test(e.key) && e.value)
      fail(`env.${e.key}: looks like a secret, so mark it secret: true`);
  }

  // GPU work holds its model weights: keep them on a volume, not re-downloaded per start.
  if (t.gpu && !t.storage) fail("gpu: templates that use GPUs need storage for their models");
  for (const a of t.args ?? []) {
    for (const [, key] of a.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g))
      if (!t.fields.some((f) => f.key === key)) fail(`args: {{${key}}} isn't a field`);
  }

  // A database's variables are the service's too, set on deploy.
  const engines = (t.databases ?? []).map((d) => d.engine);
  if (new Set(engines).size !== engines.length) fail("databases: one of each engine");
  const fromDatabases = new Set<string>();
  for (const db of t.databases ?? []) {
    // Postgres (and KV once Pyo offers any): names from Pyo's catalog.
    const ext = db.extensions ?? [];
    const known: readonly string[] = (EXTENSIONS as Record<string, readonly string[]>)[db.engine] ?? [];
    if (ext.length && !known.length) fail(`databases.${db.engine}.extensions: ${db.engine} databases have none`);
    else
      for (const name of ext)
        if (!known.includes(name)) fail(`databases.${db.engine}.extensions: Pyo doesn't offer "${name}" (scripts/extensions.ts lists them)`);
    if (new Set(ext).size !== ext.length) fail(`databases.${db.engine}.extensions: a name is repeated`);
    for (const [key, from] of Object.entries(db.env)) {
      if (keys.includes(key)) fail(`databases.${db.engine}.env.${key}: it's in env too; the database sets it`);
      if (fromDatabases.has(key)) fail(`databases.${db.engine}.env.${key}: another database sets it too`);
      fromDatabases.add(key);
      const offered: readonly string[] = DATABASE_VARIABLES[db.engine];
      for (const name of from.split(":"))
        if (!offered.includes(name))
          fail(`databases.${db.engine}.env.${key}: ${db.engine} offers ${offered.join(", ")}, not ${name}`);
    }
  }
  // ${{self.VAR}} is the service itself, ${{<companion>.VAR}} one of its
  // companions; any other reference names a service the template can't know.
  for (const e of t.env)
    for (const [, service] of (e.value ?? "").matchAll(/\$\{\{\s*([a-z0-9-]+)\./g))
      if (service !== "self" && !names.includes(service))
        fail(`env.${e.key}: only \${{self.…}} and companion references are allowed`);

  const fieldKeys = t.fields.map((f) => f.key);
  if (new Set(fieldKeys).size !== fieldKeys.length) fail("fields: a key is repeated");
  for (const f of t.fields) {
    if (f.key === "version")
      fail('fields.version: the picker comes from the image tag and x-pyo.versions, so remove this field');
    if (f.sensitive && f.default !== undefined && f.default !== "")
      fail(`fields.${f.key}: a sensitive field can't have a default`);
    if (f.envKey && !keys.includes(f.envKey))
      fail(`fields.${f.key}: envKey "${f.envKey}" isn't in env`);
    if (f.type === "select" && !f.options?.length) fail(`fields.${f.key}: select needs options`);
    if (f.type === "select" && f.default !== undefined && !f.options?.includes(String(f.default)))
      fail(`fields.${f.key}: its default isn't one of its options`);
  }

  return errors;
}

/** SVGs end up in the dashboard, so only plain drawing elements get through. */
export function logoErrors(svg: string) {
  const errors: string[] = [];
  if (svg.length > MAX_LOGO) errors.push("logo.svg is over 16 KB");
  if (!/^\s*<svg[\s>]/.test(svg)) errors.push("logo.svg must start with <svg");
  const allowed = new Set(["svg", "path", "g", "title", "circle", "rect", "ellipse", "line", "polygon", "polyline", "defs", "linearGradient", "radialGradient", "stop"]);
  for (const [, tag] of svg.matchAll(/<\s*([a-zA-Z][\w:-]*)/g))
    if (!allowed.has(tag)) errors.push(`logo.svg: <${tag}> isn't allowed`);
  if (/\son\w+\s*=/i.test(svg)) errors.push("logo.svg: event handlers aren't allowed");
  if (/\b(xlink:)?href\s*=|javascript:|url\(\s*['"]?(?!#)|<!|<\?/i.test(svg))
    errors.push("logo.svg: links, external references and doctypes aren't allowed");
  return errors;
}

/** Every problem with one template, as readable lines. */
export function checkTemplate(raw: unknown, folder: string, dir?: string) {
  const errors = schemaErrors(raw);
  if (errors.length) return errors;
  const t = raw as Template;
  errors.push(...ruleErrors(t, folder));
  if (dir && t.logo) {
    const path = join(dir, t.logo);
    if (!existsSync(path)) errors.push("logo.svg is declared but missing");
    else errors.push(...logoErrors(readFileSync(path, "utf8")));
  }
  return errors;
}

export const templateFolders = () =>
  readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

export const composePath = (folder: string) => join(TEMPLATES_DIR, folder, "compose.yaml");

/** A folder's compose.yaml, as the template Pyo reads, or every problem with it. */
export function loadTemplate(folder: string): { template?: Template; errors: string[] } {
  let raw: unknown;
  try {
    raw = parseTemplate(readFileSync(composePath(folder), "utf8"));
  } catch (e) {
    return { errors: [`compose.yaml can't be read: ${(e as Error).message.split("\n")[0]}`] };
  }
  const { template, errors } = composeToTemplate(raw, folder);
  if (!template) return { errors };
  const more = checkTemplate(template, folder, join(TEMPLATES_DIR, folder));
  return more.length ? { errors: more } : { template, errors: [] };
}
