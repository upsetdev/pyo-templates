// Publishes what Pyo loads: dist/v1/index.json and the logos. Each template's
// compose.yaml becomes one entry (scripts/compose.ts); Pyo only ever reads
// this JSON, so it never parses YAML or Compose files from the internet.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { loadTemplate, ROOT, templateFolders, TEMPLATES_DIR } from "./lib";

const out = join(ROOT, "dist", "v1");
rmSync(join(ROOT, "dist"), { recursive: true, force: true });
mkdirSync(join(out, "logos"), { recursive: true });

const catalog = parse(readFileSync(join(ROOT, "catalog.yaml"), "utf8")) ?? {};
const order: string[] = catalog.order ?? [];
const rank = (id: string) => {
  const i = order.indexOf(id);
  return i === -1 ? order.length : i;
};

const templates = templateFolders()
  .map((folder) => {
    const { template, errors } = loadTemplate(folder);
    if (!template) throw new Error(`${folder}: ${errors.join("; ")}`);
    return template;
  })
  .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id))
  .map((t) => {
    const { logo, featured, hidden, ...rest } = t;
    if (logo) copyFileSync(join(TEMPLATES_DIR, t.id, logo), join(out, "logos", `${t.id}.svg`));
    return {
      ...rest,
      logo: logo ? `logos/${t.id}.svg` : null,
      featured: !!featured,
      // Only when set, so it's absent for the many that aren't.
      ...(hidden ? { hidden: true } : {}),
    };
  });

const index = { schema: 1, count: templates.length, templates };
writeFileSync(join(out, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
console.log(`dist/v1/index.json: ${templates.length} templates`);
