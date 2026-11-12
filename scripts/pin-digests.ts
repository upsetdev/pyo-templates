// Fills in the digest of every image in each compose.yaml (and of the other
// versions in x-pyo.versions), by asking its registry, so a tag can't change
// underneath the people using it.
//   bun run pin              fill in the missing ones
//   bun run pin --refresh    look all of them up again
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { splitImage } from "./compose";
import { composePath, templateFolders } from "./lib";

const ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const API: Record<string, string> = { "docker.io": "registry-1.docker.io" };

async function digestOf(image: string, tag: string) {
  const [registry, ...rest] = image.split("/");
  const url = `https://${API[registry] ?? registry}/v2/${rest.join("/")}/manifests/${tag}`;
  const head = (token?: string) =>
    fetch(url, {
      method: "HEAD",
      headers: { Accept: ACCEPT, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });

  let res = await head();
  if (res.status === 401) {
    // Public images still want an anonymous token.
    const challenge = res.headers.get("www-authenticate") ?? "";
    const param = (name: string) => new RegExp(`${name}="([^"]+)"`).exec(challenge)?.[1];
    const query = new URLSearchParams({
      service: param("service") ?? "",
      scope: `repository:${rest.join("/")}:pull`,
    });
    const auth = await (await fetch(`${param("realm")}?${query}`)).json();
    res = await head(auth.token ?? auth.access_token);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const digest = res.headers.get("docker-content-digest");
  if (!digest) throw new Error("no digest in the response");
  return digest;
}

const refresh = process.argv.includes("--refresh");
let changed = 0;
let failed = 0;

/** The digest to write, or undefined to leave it as it is. */
async function pin(folder: string, image: string, tag: string, current: string) {
  if (current.startsWith("sha256:") && !refresh) return undefined;
  try {
    const digest = await digestOf(image, tag);
    if (digest === current) return undefined;
    changed++;
    console.log(`${folder}: ${image}:${tag} ${digest}`);
    return digest;
  } catch (e) {
    failed++;
    console.error(`${folder}: ${image}:${tag}: ${(e as Error).message}`);
    return undefined;
  }
}

for (const folder of templateFolders()) {
  const path = composePath(folder);
  if (!existsSync(path)) continue;
  const doc = parseDocument(readFileSync(path, "utf8"));
  let dirty = false;
  // Every service's image: registry/repository:tag, then @sha256:… added.
  const services = doc.get("services") as { items: { key: { value: string } }[] } | undefined;
  let mainImage = "";
  for (const { key } of services?.items ?? []) {
    const ref = String(doc.getIn(["services", key.value, "image"]) ?? "");
    const parts = splitImage(ref);
    if (!parts) continue;
    if (key.value === folder || !mainImage) mainImage = parts.image;
    const digest = await pin(folder, parts.image, parts.tag, parts.digest);
    if (digest) {
      doc.setIn(["services", key.value, "image"], `${parts.image}:${parts.tag}@${digest}`);
      dirty = true;
    }
  }
  // More versions of the main image, offered in the deploy form.
  const versions = doc.getIn(["x-pyo", "versions"]) as { items: unknown[] } | undefined;
  for (let i = 0; i < (versions?.items.length ?? 0); i++) {
    const tag = String(doc.getIn(["x-pyo", "versions", i, "tag"]));
    const current = String(doc.getIn(["x-pyo", "versions", i, "digest"]) ?? "");
    const digest = mainImage && (await pin(folder, mainImage, tag, current));
    if (digest) {
      doc.setIn(["x-pyo", "versions", i, "digest"], digest);
      dirty = true;
    }
  }
  if (dirty) writeFileSync(path, doc.toString({ lineWidth: 0 }));
}

console.log(`${changed} digests updated, ${failed} failed`);
if (failed) process.exit(1);
