// compose.yaml → the template Pyo reads (one entry of index.json).
//
// A template is a Compose file people can run with `docker compose up`, plus
// Pyo's own data in `x-pyo` fields. Only a small part of Compose is allowed,
// and everything else is refused with a reason, so a template stays data:
// no builds, no host access, no privileged settings.
import Ajv from "ajv";
import composeSchema from "../schema.json";
import type { Companion, Template } from "./lib";

/** Services with this profile are for trying the template locally only. */
export const LOCAL_PROFILE = "local";

/** Keys refused outright, with the reason people see. */
const REFUSED: Record<string, string> = {
  build: "templates use a published image; build it and push it to a registry",
  privileged: "privileged containers aren't allowed",
  network_mode: "templates can't choose the network mode",
  devices: "host devices aren't allowed (GPUs go in x-pyo.gpu)",
  cap_add: "added capabilities aren't allowed",
  ports: "published host ports aren't allowed: list the container's ports in expose, and how Pyo exposes them in x-pyo.expose",
  extends: "extends isn't allowed: write the service out in full",
  env_file: "env_file isn't allowed: put the variables in environment",
  volumes_from: "volumes_from isn't allowed",
  pid: "the host's PID namespace isn't allowed",
  ipc: "the host's IPC namespace isn't allowed",
  userns_mode: "userns_mode isn't allowed",
  security_opt: "security_opt isn't allowed",
  sysctls: "sysctls aren't allowed",
  cgroup_parent: "cgroup_parent isn't allowed",
  links: "links aren't needed: services reach each other by name",
  external_links: "external_links aren't allowed",
  extra_hosts: "extra_hosts aren't allowed",
  configs: "configs aren't supported yet: use environment or command",
  secrets: "Compose secrets aren't supported: use x-pyo.generate or a sensitive field",
};
const REFUSED_TOP: Record<string, string> = {
  include: "include isn't allowed: a template is one file",
  networks: "networks aren't supported: services share one network",
  configs: "configs aren't supported yet",
  secrets: "Compose secrets aren't supported: use x-pyo.generate or a sensitive field",
};

const validateCompose = new Ajv({ allErrors: true, allowUnionTypes: true }).compile(composeSchema);

function schemaErrors(raw: unknown) {
  if (validateCompose(raw)) return [];
  return (validateCompose.errors ?? [])
    .filter((e) => !e.schemaPath.includes("/oneOf/") && !e.schemaPath.includes("/anyOf/"))
    .map((e) => {
      const at = e.instancePath.replace(/^\//, "").replaceAll("/", ".") || "compose.yaml";
      const extra = (e.params as { additionalProperty?: string }).additionalProperty;
      return extra ? `${at}: "${extra}" isn't allowed` : `${at}: ${e.message}`;
    });
}

/** "1m30s" → 90. Compose's durations: h, m, s and ms (whole seconds only). */
export function seconds(d: string): number | undefined {
  const m = /^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+)s)?$/.exec(d.trim());
  if (!m || !d.trim()) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/** "0.25" → 250 millicores. */
export function millicores(v: string | number): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const m = Math.round(n * 1000);
  return Math.abs(m - n * 1000) < 1e-6 ? m : undefined;
}

/** "512M" or "2G" → MiB. */
export function mebibytes(v: string | number): number | undefined {
  const m = /^(\d+)\s*(m|mb|mi|mib|g|gb|gi|gib)$/i.exec(String(v).trim());
  if (!m) return undefined;
  return Number(m[1]) * (m[2].toLowerCase().startsWith("g") ? 1024 : 1);
}

/**
 * Compose replaces `${VAR}` and `$VAR` with the shell's variables; `$$` is a
 * plain `$`. Pyo doesn't interpolate, so a template writes `$$` for `$`
 * (`$${{self.PUBLIC_URL}}`) and never relies on interpolation.
 */
function literal(s: string, where: string, fail: (m: string) => void) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "$") {
      out += s[i];
      continue;
    }
    if (s[i + 1] === "$") {
      out += "$";
      i++;
      continue;
    }
    if (/[{A-Za-z_]/.test(s[i + 1] ?? "")) {
      fail(`${where}: Compose would replace "${s.slice(i, i + 12)}…" from the shell; write $$ for a plain $`);
      return s;
    }
    out += "$";
  }
  return out;
}

/** "registry/repo:tag@sha256:…" → its parts. */
export function splitImage(ref: string) {
  const m = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+(?::[0-9]+)?\/[a-z0-9._/-]+):([A-Za-z0-9_][A-Za-z0-9._-]{0,127})(?:@(sha256:[a-f0-9]{64}))?$/.exec(ref);
  if (!m) return undefined;
  return { image: m[1], tag: m[2], digest: m[3] ?? "" };
}

const words = (v: unknown) => (typeof v === "string" ? undefined : (v as string[] | undefined));

type Raw = Record<string, any>;
type Converted = { template?: Template; errors: string[] };

/** Ports a service lists in `expose`, as "port/protocol". */
function exposed(list: (string | number)[] | undefined) {
  return new Set(
    (list ?? []).map((p) => {
      const [port, proto = "tcp"] = String(p).split("/");
      return `${Number(port)}/${proto.toLowerCase()}`;
    }),
  );
}

function convertService(name: string, s: Raw, volumes: Raw, fail: (m: string) => void) {
  const at = `services.${name}`;
  const x = s["x-pyo"] ?? {};

  const ref = splitImage(String(s.image ?? ""));
  if (!ref)
    fail(`${at}.image: use registry/repository:tag@sha256:digest (e.g. docker.io/library/nginx:1.27@sha256:…); run bun run pin for the digest`);
  else if (!ref.digest) fail(`${at}.image: pin it by digest: run bun run pin`);

  if (typeof s.command === "string" || typeof s.entrypoint === "string")
    fail(`${at}: write command and entrypoint as lists, so no shell splits them`);
  const args = words(s.command)?.map((a, i) => literal(String(a), `${at}.command[${i}]`, fail));
  const entrypoint = words(s.entrypoint)?.map((a, i) => literal(String(a), `${at}.entrypoint[${i}]`, fail));

  // Environment: a value is set as it is; no value is a secret, made by
  // Pyo (x-pyo.generate) or given in the deploy form (a sensitive field).
  if (Array.isArray(s.environment))
    fail(`${at}.environment: use the KEY: value form`);
  const env = Object.entries((s.environment ?? {}) as Record<string, unknown>).map(([key, v]) =>
    v === null || v === undefined
      ? { key, value: undefined }
      : { key, value: literal(String(v), `${at}.environment.${key}`, fail) },
  );

  // One named volume, with its size in x-pyo.
  let storage: Template["storage"];
  const mounts = (s.volumes ?? []) as (string | Raw)[];
  if (mounts.length > 1) fail(`${at}.volumes: Pyo templates have one volume for now`);
  for (const m of mounts) {
    const [source, target, mode] =
      typeof m === "string" ? m.split(":") : [m.source, m.target, m.read_only ? "ro" : undefined];
    if (typeof m !== "string" && m.type && m.type !== "volume") {
      fail(`${at}.volumes: only named volumes are allowed, not ${m.type}`);
      continue;
    }
    if (!source || /^[./~]/.test(source) || source.includes("/")) {
      fail(`${at}.volumes: "${source ?? ""}" is a host path; only named volumes are allowed`);
      continue;
    }
    if (mode !== undefined) fail(`${at}.volumes: mount options (":${mode}") aren't supported`);
    const v = volumes[source];
    if (v === undefined) {
      fail(`${at}.volumes: "${source}" isn't under the top-level volumes`);
      continue;
    }
    const vx = v?.["x-pyo"];
    if (!vx?.sizeGi) {
      fail(`volumes.${source}: give its size in x-pyo.sizeGi`);
      continue;
    }
    storage = { required: vx.required ?? true, sizeGi: vx.sizeGi, mountPath: target };
  }

  // Ports: the container's in `expose`, how Pyo exposes them in x-pyo.expose.
  const listed = exposed(s.expose);
  const described = new Set<string>();
  const ports = ((x.expose ?? []) as Raw[]).map((p) => {
    const asIs = p.as ?? "internal";
    const fromCompose = listed.has(`${p.port}/udp`) && !listed.has(`${p.port}/tcp`) ? "udp" : "tcp";
    const protocol: string = p.protocol ?? (asIs === "http" ? "http" : fromCompose);
    const transport = protocol === "udp" ? "udp" : "tcp";
    if (!listed.has(`${p.port}/${transport}`))
      fail(`${at}.x-pyo.expose: port ${p.port}/${transport} isn't in the service's expose list`);
    described.add(`${p.port}/${transport}`);
    if (asIs === "http" && protocol !== "http") fail(`${at}.x-pyo.expose: as: http needs protocol http`);
    return {
      name: p.name as string,
      port: p.port as number,
      protocol: protocol.toUpperCase(),
      exposure: asIs === "tcp" ? "loadbalancer" : asIs,
    };
  });
  for (const p of listed)
    if (!described.has(p)) fail(`${at}.expose: say how Pyo exposes ${p} in x-pyo.expose`);

  // Health check: Pyo's own HTTP or TCP probe, a command, or none.
  const h = s.healthcheck as Raw | undefined;
  let healthCheck: Template["healthCheck"] | undefined;
  if (!h) fail(`${at}: a healthcheck is required`);
  else {
    const hx = h["x-pyo"] ?? {};
    const delay = seconds(String(h.start_period ?? "0s"));
    const period = seconds(String(h.interval ?? "30s"));
    if (delay === undefined) fail(`${at}.healthcheck.start_period: use whole seconds, e.g. 20s`);
    if (period === undefined) fail(`${at}.healthcheck.interval: use whole seconds, e.g. 10s`);
    const timing = { initialDelaySeconds: delay ?? 0, periodSeconds: period ?? 0 };
    const test = h.test as string | string[] | undefined;
    const kinds = [hx.http, hx.tcp, test, h.disable].filter((k) => k !== undefined && k !== false);
    if (kinds.length !== 1)
      fail(`${at}.healthcheck: use one of x-pyo.http, x-pyo.tcp, test or disable: true`);
    else if (hx.http) healthCheck = { type: "http", path: hx.http.path, port: hx.http.port, ...timing };
    else if (hx.tcp) healthCheck = { type: "tcp", port: hx.tcp, ...timing };
    else if (h.disable || (Array.isArray(test) && test[0] === "NONE"))
      healthCheck = { type: "none", ...timing };
    else if (typeof test === "string" || test?.[0] === "CMD-SHELL") {
      const command = typeof test === "string" ? test : test.slice(1).join(" ");
      healthCheck = { type: "exec", command: literal(command, `${at}.healthcheck.test`, fail), ...timing };
    } else if (test?.[0] === "CMD") {
      const q = (w: string) => (/^[\w./:=@%+-]+$/.test(w) ? w : `'${w.replaceAll("'", "'\\''")}'`);
      healthCheck = { type: "exec", command: literal(test.slice(1).map(q).join(" "), `${at}.healthcheck.test`, fail), ...timing };
    } else fail(`${at}.healthcheck.test: start it with CMD, CMD-SHELL or NONE`);
  }

  // Size: Compose's deploy.resources, reservations as Pyo's requests.
  const r = s.deploy?.resources ?? {};
  const cpu = (v: unknown, k: string) => {
    const n = v === undefined ? undefined : millicores(v as string);
    if (n === undefined) fail(`${at}.deploy.resources.${k}.cpus: a number of CPUs, e.g. "0.25"`);
    return n ?? 0;
  };
  const mem = (v: unknown, k: string) => {
    const n = v === undefined ? undefined : mebibytes(v as string);
    if (n === undefined) fail(`${at}.deploy.resources.${k}.memory: MiB or GiB, e.g. 256M or 1G`);
    return n ?? 0;
  };
  const resources = {
    cpuRequest: cpu(r.reservations?.cpus, "reservations"),
    cpuLimit: cpu(r.limits?.cpus, "limits"),
    memoryRequest: mem(r.reservations?.memory, "reservations"),
    memoryLimit: mem(r.limits?.memory, "limits"),
  };

  const stateful = !!storage;
  return {
    ref,
    args,
    entrypoint,
    env,
    storage,
    ports,
    healthCheck,
    resources,
    stateful,
    workload: (x.workload ?? (stateful ? "StatefulSet" : "Deployment")) as string,
    replicas: (s.deploy?.replicas ?? 1) as number,
    gpu: x.gpu as Template["gpu"],
  };
}

/** Every refused key in the file, with its reason. */
function refusedErrors(raw: Raw) {
  const errors: string[] = [];
  for (const [k, why] of Object.entries(REFUSED_TOP)) if (k in raw) errors.push(`${k}: ${why}`);
  for (const [name, s] of Object.entries((raw.services ?? {}) as Record<string, Raw>)) {
    if (!s || typeof s !== "object") continue;
    for (const [k, why] of Object.entries(REFUSED)) if (k in s) errors.push(`services.${name}.${k}: ${why}`);
  }
  return errors;
}

/**
 * The template a compose.yaml describes, or why it can't be one. `id` is its
 * folder's name.
 */
export function composeToTemplate(raw: unknown, id: string): Converted {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { errors: ["compose.yaml: expected a Compose file"] };
  const c = raw as Raw;
  const refused = refusedErrors(c);
  if (refused.length) return { errors: refused };
  const schema = schemaErrors(c);
  if (schema.length) return { errors: schema };

  const errors: string[] = [];
  const fail = (m: string) => errors.push(m);
  const x = c["x-pyo"] as Raw;
  if (x.database && x.databases) fail("x-pyo: use database (one) or databases (several), not both");
  const services = c.services as Record<string, Raw>;
  const volumes = (c.volumes ?? {}) as Raw;

  for (const [name, s] of Object.entries(services))
    for (const d of (Array.isArray(s.depends_on) ? s.depends_on : Object.keys(s.depends_on ?? {})) as string[])
      if (!(d in services)) fail(`services.${name}.depends_on: "${d}" isn't a service here`);

  const local = (s: Raw) => (s.profiles as string[] | undefined)?.includes(LOCAL_PROFILE);
  for (const [name, s] of Object.entries(services))
    for (const d of (Array.isArray(s.depends_on) ? s.depends_on : Object.keys(s.depends_on ?? {})) as string[])
      if (!local(s) && services[d] && local(services[d]))
        fail(`services.${name}.depends_on: "${d}" only runs locally, so docker compose config fails without --profile local; use restart: unless-stopped instead`);
  for (const [name, s] of Object.entries(services))
    if (s.profiles && !(s.profiles.length === 1 && local(s)))
      fail(`services.${name}.profiles: only [${LOCAL_PROFILE}] is allowed, for services that only run locally`);

  // The service Pyo deploys: the only one, or the one named like the folder.
  // Others (not local) are its companions, deployed next to it.
  const deployed = Object.entries(services).filter(([, s]) => !local(s));
  const main =
    deployed.length === 1 ? deployed[0] : deployed.find(([name]) => name === id);
  if (!deployed.length) fail("services: there's no service to deploy (all are local)");
  else if (!main) fail(`services: with several services, the one Pyo deploys is named "${id}", like the folder`);
  if (!main || errors.length) return { errors };

  const [mainName, mainRaw] = main;
  const svc = convertService(mainName, mainRaw, volumes, fail);
  const companions = deployed
    .filter(([name]) => name !== mainName)
    .map(([name, s]) => ({ name, ...convertService(name, s, volumes, fail) }));

  // Generated values and secrets.
  // A name (a 24-character password), or { key, format } for another kind.
  type Gen = { key: string; format?: string; prefix?: string };
  const made = new Map<string, Gen>(
    ((x.generate ?? []) as (string | Gen)[]).map((g) => (typeof g === "string" ? [g, { key: g }] : [g.key, g])),
  );
  const formats = new Map([...made].map(([k, g]) => [k, g.format === "password" ? undefined : g.format]));
  const generate = [...formats.keys()];
  const sensitive = new Set(
    ((x.fields ?? []) as Raw[]).filter((f) => f.sensitive && f.envKey).map((f) => f.envKey as string),
  );
  for (const k of generate) {
    const e = svc.env.find((e) => e.key === k);
    if (!e) fail(`x-pyo.generate: ${k} isn't in services.${mainName}.environment`);
    else if (e.value !== undefined) fail(`services.${mainName}.environment.${k}: a generated value is left empty`);
  }
  // A companion's address in the main service's variables: Compose finds it
  // by its service name, Pyo by a reference the dashboard fills in.
  const rewrite = (v: string) =>
    companions.reduce(
      (acc, co) =>
        acc.replace(
          new RegExp(`(^|[/@])${co.name.replace(/[-.]/g, "\\$&")}(?=[:/]|$)`, "g"),
          `$1\${{${co.name}.HOST}}`,
        ),
      v,
    );
  // A variable a database sets can have a value for trying it locally
  // (pointing at a local service); Pyo sets it from the database instead.
  const fromDatabase = new Set(
    ((x.databases ?? (x.database ? [x.database] : [])) as Raw[]).flatMap((d) => Object.keys(d.env ?? {})),
  );
  const env = svc.env.filter((e) => !fromDatabase.has(e.key)).map((e) =>
    e.value === undefined
      ? {
          key: e.key,
          secret: true,
          ...(generate.includes(e.key) ? { generate: true } : {}),
          ...(formats.get(e.key) ? { format: formats.get(e.key) } : {}),
          ...(made.get(e.key)?.prefix ? { prefix: made.get(e.key)?.prefix } : {}),
        }
      : { key: e.key, value: rewrite(e.value) },
  );
  for (const e of env)
    if ("secret" in e && !generate.includes(e.key) && !sensitive.has(e.key))
      fail(`services.${mainName}.environment.${e.key}: give it a value, list it in x-pyo.generate, or add a sensitive field for it`);

  if (!svc.ref || !svc.healthCheck) return { errors };
  const versions = [{ tag: svc.ref.tag, digest: svc.ref.digest }, ...((x.versions ?? []) as Template["source"]["versions"])];

  const template: Template = {
    schema: 1,
    id,
    name: x.name,
    description: x.description,
    category: x.category,
    ...(x.logo ? { logo: x.logo } : {}),
    tier: x.tier,
    author: x.author,
    ...(x.homepage ? { homepage: x.homepage } : {}),
    version: x.version,
    ...(x.appVersion ? { appVersion: x.appVersion } : {}),
    ...(x.upgrade ? { upgrade: x.upgrade } : {}),
    minPyoVersion: x.minPyoVersion,
    source: { type: "image", image: svc.ref.image, versions },
    kind: x.kind,
    workload: svc.workload,
    stateful: svc.stateful,
    replicas: svc.replicas,
    resources: svc.resources,
    ...(svc.gpu ? { gpu: svc.gpu } : {}),
    ...(svc.args ? { args: svc.args } : {}),
    ...(svc.entrypoint ? { entrypoint: svc.entrypoint } : {}),
    ...(svc.storage ? { storage: svc.storage } : {}),
    ports: svc.ports,
    healthCheck: svc.healthCheck,
    env,
    // One database (database:) or several (databases:), always a list here.
    ...(x.database || x.databases ? { databases: x.databases ?? [x.database] } : {}),
    fields: x.fields ?? [],
    hints: x.hints ?? [],
    ...(x.featured ? { featured: true } : {}),
    ...(x.hidden ? { hidden: true } : {}),
  };
  if (companions.length)
    template.companions = companions.map((co): Companion => {
      for (const e of co.env)
        if (e.value === undefined)
          fail(`services.${co.name}.environment.${e.key}: a companion's variables have values`);
      if (co.gpu) fail(`services.${co.name}.x-pyo.gpu: only the main service can use GPUs`);
      return {
        name: co.name,
        image: co.ref?.image ?? "",
        version: { tag: co.ref?.tag ?? "", digest: co.ref?.digest ?? "" },
        workload: co.workload as Companion["workload"],
        stateful: co.stateful,
        replicas: co.replicas,
        resources: co.resources,
        ...(co.args ? { args: co.args } : {}),
        ...(co.entrypoint ? { entrypoint: co.entrypoint } : {}),
        ...(co.storage ? { storage: co.storage } : {}),
        ports: co.ports as Companion["ports"],
        healthCheck: co.healthCheck as Companion["healthCheck"],
        env: co.env.map((e) => ({ key: e.key, value: e.value ?? "" })),
      };
    });
  return errors.length ? { errors } : { template, errors };
}
