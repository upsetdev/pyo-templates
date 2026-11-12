// Checks every template and the catalog. Exits non-zero on any problem.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { extensionDrift } from "./extensions";
import { loadTemplate, ROOT, templateFolders } from "./lib";

let failed = 0;
const report = (where: string, errors: string[]) => {
  if (!errors.length) return;
  failed += errors.length;
  console.error(`\n${where}`);
  for (const e of errors) console.error(`  - ${e}`);
};

const folders = templateFolders();
for (const folder of folders) report(folder, loadTemplate(folder).errors);

const catalog = parse(readFileSync(join(ROOT, "catalog.yaml"), "utf8")) ?? {};
const unknown = (list: string[]) => list.filter((id) => !folders.includes(id));
report("catalog.yaml", [
  ...unknown(catalog.order ?? []).map((id) => `order: "${id}" isn't a template`),
  ...Object.keys(catalog)
    .filter((k) => k !== "order")
    .map((k) => `${k}: only order goes here (featured and hidden are in each template's x-pyo)`),
]);

// The extension names, against Pyo's catalog when it's checked out next to this.
report("scripts/extensions.ts (keep it in step with pyo/crates/pyo-db-controller/extensions.json)", extensionDrift(ROOT));

if (failed) {
  console.error(`\n${failed} problem${failed === 1 ? "" : "s"} found`);
  process.exit(1);
}
console.log(`${folders.length} templates are valid`);
