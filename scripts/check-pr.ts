// Pull request rules that depend on who opened it. Run by CI, which provides:
//   PR_AUTHOR              the GitHub username
//   PR_ASSOCIATION         OWNER, MEMBER, COLLABORATOR or something else
//   PR_BASE                the commit to compare with
import { execFileSync } from "node:child_process";
import { loadTemplate, parseTemplate } from "./lib";

const { PR_AUTHOR, PR_ASSOCIATION, PR_BASE } = process.env;
if (!PR_AUTHOR || !PR_BASE) {
  console.error("PR_AUTHOR and PR_BASE are required");
  process.exit(2);
}
const maintainer = ["OWNER", "MEMBER", "COLLABORATOR"].includes(PR_ASSOCIATION ?? "");

const changes = execFileSync("git", ["diff", "--name-status", PR_BASE, "HEAD", "--", "templates", "catalog.yaml", "schema.json", "template.schema.json", "scripts", ".github"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .map((line) => line.split("\t"));

/** The file's x-pyo as it was on the base branch. */
function baseXPyo(path: string) {
  try {
    const text = execFileSync("git", ["show", `${PR_BASE}:${path}`], { encoding: "utf8" });
    return (parseTemplate(text) as { "x-pyo"?: { featured?: boolean; hidden?: boolean; version?: string } })["x-pyo"];
  } catch {
    return undefined;
  }
}

/** a > b, for versions validate already checked (1.2.3). */
const newer = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

const errors: string[] = [];
for (const [status, path] of changes) {
  const [, folder, file] = /^templates\/([^/]+)\/(.+)$/.exec(path) ?? [];
  if (!folder) {
    if (!maintainer) errors.push(`${path}: only maintainers change this file`);
    continue;
  }
  if (status === "D") {
    if (!maintainer) errors.push(`${folder}: only maintainers remove a template`);
    continue;
  }
  if (file !== "compose.yaml" && file !== "logo.svg")
    errors.push(`${path}: a template folder holds compose.yaml and logo.svg only`);
  if (file !== "compose.yaml") continue;
  const { template: t } = loadTemplate(folder);
  if (!t) continue; // validate reports why
  const before = status === "A" ? undefined : baseXPyo(path);
  // Services record the version they came from, so every change gets a new one.
  if (before?.version && !newer(t.version, before.version))
    errors.push(`${folder}: bump x-pyo.version (it's ${before.version} on the base branch)`);
  if (maintainer) continue;
  // Featured and hidden are the maintainers' to change.
  const flags = (x: { featured?: boolean; hidden?: boolean } | undefined) => `${!!x?.featured}/${!!x?.hidden}`;
  if (flags(t) !== flags(before)) errors.push(`${folder}: only maintainers set featured or hidden`);
  if (t.tier !== "community") errors.push(`${folder}: contributions use tier: community`);
  if (status === "A" && t.author.toLowerCase() !== PR_AUTHOR.toLowerCase())
    errors.push(`${folder}: author must be your GitHub username (${PR_AUTHOR})`);
  if (status !== "A" && t.author.toLowerCase() !== PR_AUTHOR.toLowerCase())
    errors.push(`${folder}: only ${t.author} or a maintainer can change this template`);
}

if (errors.length) {
  for (const e of errors) console.error(`- ${e}`);
  process.exit(1);
}
console.log(`${changes.length} changed files are fine for ${PR_AUTHOR}`);
