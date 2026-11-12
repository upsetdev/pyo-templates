import { describe, expect, test } from "bun:test";
import { composeToTemplate, mebibytes, millicores, seconds, splitImage } from "./compose";
import { checkTemplate, parseTemplate } from "./lib";

const digest = `sha256:${"a".repeat(64)}`;

const service = () => ({
  image: `docker.io/acme/demo:1.0@${digest}`,
  environment: { MODE: "production" } as Record<string, unknown>,
  expose: ["8080"],
  healthcheck: { start_period: "5s", interval: "10s", "x-pyo": { http: { path: "/", port: 8080 } } },
  deploy: {
    replicas: 1,
    resources: {
      reservations: { cpus: "0.1", memory: "64M" },
      limits: { cpus: "0.2", memory: "128M" },
    },
  },
  "x-pyo": { expose: [{ name: "http", port: 8080, as: "http" }] },
});

const compose = (patch: (c: any) => void = () => {}) => {
  const c: any = {
    "x-pyo": {
      name: "Demo",
      description: "A small service used to test the converter.",
      category: "other",
      tier: "community",
      author: "someone",
      version: "1.0.0",
      minPyoVersion: "0.1.0",
      kind: "service",
    },
    services: { demo: service() },
  };
  patch(c);
  return c;
};
const convert = (patch?: (c: any) => void) => composeToTemplate(compose(patch), "demo");
const errorsOf = (patch?: (c: any) => void) => {
  const { template, errors } = convert(patch);
  return [...errors, ...(template ? checkTemplate(template, "demo") : [])].join("\n");
};

describe("compose.yaml", () => {
  test("a good one becomes a template", () => {
    const { template, errors } = convert();
    expect(errors).toEqual([]);
    expect(checkTemplate(template!, "demo")).toEqual([]);
    expect(template).toMatchObject({
      id: "demo",
      source: { type: "image", image: "docker.io/acme/demo", versions: [{ tag: "1.0", digest }] },
      workload: "Deployment",
      stateful: false,
      replicas: 1,
      resources: { cpuRequest: 100, cpuLimit: 200, memoryRequest: 64, memoryLimit: 128 },
      ports: [{ name: "http", port: 8080, protocol: "HTTP", exposure: "http" }],
      healthCheck: { type: "http", path: "/", port: 8080, initialDelaySeconds: 5, periodSeconds: 10 },
      env: [{ key: "MODE", value: "production" }],
    });
  });

  test.each([
    ["build", { build: "." }],
    ["privileged", { privileged: true }],
    ["network_mode", { network_mode: "host" }],
    ["devices", { devices: ["/dev/kvm"] }],
    ["cap_add", { cap_add: ["NET_ADMIN"] }],
    ["ports", { ports: ["80:8080"] }],
    ["extends", { extends: { service: "x" } }],
  ])("refuses %s, with a reason", (key, extra) => {
    const e = errorsOf((c) => Object.assign(c.services.demo, extra));
    expect(e).toContain(`services.demo.${key}:`);
    expect(e.split(":").length).toBeGreaterThan(1);
  });

  test("its own version, the app's, and the reserved upgrade notes", () => {
    expect(convert().template).toMatchObject({ version: "1.0.0" });
    expect(convert().template?.appVersion).toBeUndefined();
    const upgrade = { breaking: true, upgradeFrom: ">=1.0.0 <2.0.0", notes: "Moves the data folder." };
    const { template } = convert((c) => Object.assign(c["x-pyo"], { version: "2.1.0", appVersion: "1.0", upgrade }));
    expect(template).toMatchObject({ version: "2.1.0", appVersion: "1.0", upgrade });
    expect(errorsOf((c) => delete c["x-pyo"].version)).toContain("version");
    for (const bad of ["1.0", "v1.0.0", "01.0.0", "1.0.0-beta", 1])
      expect(errorsOf((c) => (c["x-pyo"].version = bad))).toContain("x-pyo.version");
    expect(errorsOf((c) => (c["x-pyo"].upgrade = { auto: true }))).toContain('"auto" isn\'t allowed');
  });

  test("refuses unknown keys, at the top and in services", () => {
    expect(errorsOf((c) => (c.services.demo.stdin_open = true))).toContain('"stdin_open" isn\'t allowed');
    expect(errorsOf((c) => (c.whatever = 1))).toContain('"whatever" isn\'t allowed');
    expect(errorsOf((c) => (c["x-pyo"].nope = 1))).toContain('"nope" isn\'t allowed');
  });

  test("named volumes only, sized in x-pyo", () => {
    const mount = (m: unknown) => (c: any) => {
      c.services.demo.volumes = [m];
      c.volumes = { data: { "x-pyo": { sizeGi: 2 } } };
    };
    const { template } = convert(mount("data:/var/lib/demo"));
    expect(template?.storage).toEqual({ required: true, sizeGi: 2, mountPath: "/var/lib/demo" });
    expect(template?.stateful).toBe(true);
    expect(template?.workload).toBe("StatefulSet");
    expect(errorsOf(mount("/srv/demo:/data"))).toContain("host path");
    expect(errorsOf(mount("./demo:/data"))).toContain("host path");
    expect(errorsOf(mount({ type: "bind", source: "/srv", target: "/data" }))).toContain("named volumes");
    expect(errorsOf(mount("other:/data"))).toContain("top-level volumes");
    expect(errorsOf((c) => {
      mount("data:/data")(c);
      c.volumes.data = null;
    })).toContain("sizeGi");
  });

  test("every exposed port says how Pyo exposes it", () => {
    expect(errorsOf((c) => c.services.demo.expose.push("9000"))).toContain("9000/tcp");
    expect(errorsOf((c) => (c.services.demo["x-pyo"].expose[0].port = 9))).toContain("isn't in the service's expose list");
    const { template } = convert((c) => {
      c.services.demo.expose = ["53/udp", "53/tcp", "8080"];
      c.services.demo["x-pyo"].expose.push(
        { name: "dns-udp", port: 53, protocol: "udp" },
        { name: "dns-tcp", port: 53, as: "tcp" },
      );
    });
    expect(template?.ports.slice(1)).toEqual([
      { name: "dns-udp", port: 53, protocol: "UDP", exposure: "internal" },
      { name: "dns-tcp", port: 53, protocol: "TCP", exposure: "loadbalancer" },
    ]);
  });

  test("a health check is required, and only one kind", () => {
    expect(errorsOf((c) => delete c.services.demo.healthcheck)).toContain("healthcheck is required");
    expect(errorsOf((c) => (c.services.demo.healthcheck.test = ["CMD", "true"]))).toContain("use one of");
    const exec = convert((c) => {
      c.services.demo.healthcheck = { test: ["CMD", "wget", "-qO-", "http://localhost/a b"], interval: "1m" };
    }).template?.healthCheck;
    expect(exec).toEqual({ type: "exec", command: "wget -qO- 'http://localhost/a b'", initialDelaySeconds: 0, periodSeconds: 60 });
  });

  test("no value is a secret: generated, or from a sensitive field", () => {
    const { template } = convert((c) => {
      c.services.demo.environment.TOKEN = null;
      c["x-pyo"].generate = ["TOKEN"];
    });
    expect(template?.env[1]).toEqual({ key: "TOKEN", secret: true, generate: true });
    expect(errorsOf((c) => (c.services.demo.environment.TOKEN = null))).toContain("x-pyo.generate");
    expect(errorsOf((c) => (c["x-pyo"].generate = ["MODE"]))).toContain("left empty");
    expect(errorsOf((c) => (c["x-pyo"].generate = ["NOPE"]))).toContain("isn't in");
  });

  test("$$ is a plain $, and Compose interpolation is refused", () => {
    const { template } = convert((c) => (c.services.demo.environment.url = "$${{self.PUBLIC_URL}}"));
    expect(template?.env[1]).toEqual({ key: "url", value: "${{self.PUBLIC_URL}}" });
    expect(errorsOf((c) => (c.services.demo.environment.url = "${HOME}"))).toContain("write $$");
    expect(errorsOf((c) => (c.services.demo.command = ["$HOME"]))).toContain("write $$");
  });

  test("images are pinned, from public registries", () => {
    expect(errorsOf((c) => (c.services.demo.image = "docker.io/acme/demo:1.0"))).toContain("bun run pin");
    expect(errorsOf((c) => (c.services.demo.image = "acme/demo:1.0"))).toContain("registry/repository");
    expect(errorsOf((c) => (c.services.demo.image = `evil.example/acme/demo:1.0@${digest}`))).toContain("allowed registry");
    const { template } = convert((c) => (c["x-pyo"].versions = [{ tag: "0.9", digest }]));
    expect(template?.source.versions.map((v) => v.tag)).toEqual(["1.0", "0.9"]);
  });

  test("local services are ignored; other profiles are refused", () => {
    const local = { image: "docker.io/library/postgres:17", profiles: ["local"] };
    const { template, errors } = convert((c) => {
      c.services.db = local;
      c.services.db.depends_on = [];
    });
    expect(errors).toEqual([]);
    expect(template?.companions).toBeUndefined();
    expect(errorsOf((c) => (c.services.db = { ...local, profiles: ["dev"] }))).toContain("profiles");
    expect(errorsOf((c) => (c.services.demo.depends_on = ["nope"]))).toContain("isn't a service here");
  });

  test("companions: deployed next to it, reached by name", () => {
    const events = service();
    events.image = `docker.io/clickhouse/clickhouse-server:25.3@${digest}`;
    events.expose = ["8123"];
    events["x-pyo"].expose = [{ name: "http", port: 8123, as: "internal", protocol: "http" }] as never;
    events.healthcheck["x-pyo"].http.port = 8123;
    const { template, errors } = convert((c) => {
      c.services["demo-events"] = events;
      c.services.demo.environment.EVENTS_URL = "http://demo-events:8123/db";
    });
    expect(errors).toEqual([]);
    expect(checkTemplate(template!, "demo")).toEqual([]);
    expect(template?.env[1]).toEqual({ key: "EVENTS_URL", value: "http://${{demo-events.HOST}}:8123/db" });
    expect(template?.companions?.[0]).toMatchObject({
      name: "demo-events",
      image: "docker.io/clickhouse/clickhouse-server",
      version: { tag: "25.3", digest },
      ports: [{ name: "http", port: 8123, protocol: "HTTP", exposure: "internal" }],
    });
    // Two deployed services: the main one is named like the folder.
    expect(composeToTemplate(compose((c) => {
      c.services.other = c.services.demo;
      c.services.another = c.services.demo;
      delete c.services.demo;
    }), "demo").errors.join()).toContain('named "demo"');
  });

  test("a service doesn't wait on a local-only one", () => {
    expect(errorsOf((c) => {
      c.services.db = { image: "docker.io/library/postgres:17", profiles: ["local"] };
      c.services.demo.depends_on = ["db"];
    })).toContain("--profile local");
  });

  test("a database's variables may have local values, which Pyo drops", () => {
    const { template, errors } = convert((c) => {
      c["x-pyo"].database = { engine: "postgres", env: { DATABASE_URL: "DATABASE_URL_DIRECT" } };
      c.services.demo.environment.DATABASE_URL = "postgres://u:p@db:5432/app";
    });
    expect(errors).toEqual([]);
    expect(template?.env.map((e) => e.key)).toEqual(["MODE"]);
    expect(template?.databases).toEqual([{ engine: "postgres", env: { DATABASE_URL: "DATABASE_URL_DIRECT" } }]);
  });

  test("several databases, one per engine", () => {
    const { template, errors } = convert((c) => {
      c["x-pyo"].databases = [
        { engine: "postgres", env: { DB_HOST: "POSTGRES_HOST:POSTGRES_PORT" } },
        { engine: "kv", env: { REDIS: "REDIS_URL" } },
      ];
    });
    expect(errors).toEqual([]);
    expect(checkTemplate(template!, "demo")).toEqual([]);
    expect(template?.databases?.map((d) => d.engine)).toEqual(["postgres", "kv"]);
    expect(errorsOf((c) => {
      c["x-pyo"].database = { engine: "kv", env: { REDIS: "REDIS_URL" } };
      c["x-pyo"].databases = [{ engine: "kv", env: { REDIS: "REDIS_URL" } }];
    })).toContain("not both");
  });

  test("generated values: a format and a prefix", () => {
    const { template } = convert((c) => {
      c.services.demo.environment.KEY = null;
      c["x-pyo"].generate = [{ key: "KEY", format: "base64-32", prefix: "base64:" }];
    });
    expect(template?.env[1]).toEqual({ key: "KEY", secret: true, generate: true, format: "base64-32", prefix: "base64:" });
    expect(errorsOf((c) => {
      c.services.demo.environment.KEY = null;
      c["x-pyo"].generate = [{ key: "KEY", format: "uuid" }];
    })).not.toBe("");
  });

  test("a Postgres database, under the template's names", () => {
    const pg = (env: Record<string, string>) => (c: any) => (c["x-pyo"].database = { engine: "postgres", env });
    expect(errorsOf(pg({ DATABASE_URL: "DATABASE_URL_DIRECT" }))).toBe("");
    expect(errorsOf(pg({ DATABASE_URL: "MYSQL_HOST" }))).toContain("postgres offers");
  });

  test("a database's extensions, from Pyo's catalog", () => {
    const db = (engine: string, extensions: unknown) => (c: any) =>
      (c["x-pyo"].database = { engine, env: { DB: engine === "kv" ? "REDIS_URL" : "DATABASE_URL" }, extensions });
    const { template, errors } = convert(db("postgres", ["pg_trgm", "vector"]));
    expect(errors).toEqual([]);
    expect(checkTemplate(template!, "demo")).toEqual([]);
    expect(template?.databases?.[0].extensions).toEqual(["pg_trgm", "vector"]);
    expect(errorsOf(db("postgres", ["postgis"]))).toContain(`doesn't offer "postgis"`);
    expect(errorsOf(db("postgres", ["pg_trgm", "pg_trgm"]))).not.toBe("");
    expect(errorsOf(db("postgres", []))).not.toBe("");
    expect(errorsOf(db("mysql", ["pg_trgm"]))).toContain("mysql databases have none");
    expect(errorsOf(db("kv", ["valkey-json"]))).toBe("");
    expect(errorsOf(db("kv", ["pg_trgm"]))).toContain(`doesn't offer "pg_trgm"`);
  });

  test("Compose's units", () => {
    expect(seconds("1m30s")).toBe(90);
    expect(seconds("600s")).toBe(600);
    expect(seconds("10ms")).toBeUndefined();
    expect(millicores("0.25")).toBe(250);
    expect(millicores(8)).toBe(8000);
    expect(millicores("0.0001")).toBeUndefined();
    expect(mebibytes("512M")).toBe(512);
    expect(mebibytes("2G")).toBe(2048);
    expect(mebibytes("1.5G")).toBeUndefined();
    expect(splitImage("docker.io/library/nginx:1.27")).toEqual({ image: "docker.io/library/nginx", tag: "1.27", digest: "" });
  });

  test("YAML safety still applies", () =>
    expect(() => parseTemplate("services: &x {a: 1}\nb: *x\n")).toThrow());
});
