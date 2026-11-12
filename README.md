# Pyo templates

One-click templates for [Pyo](https://github.com/upsetdev/pyo), the open-source,
self-hosted PaaS.

Each template is a Docker Compose file: the image, its variables, volume, ports
and health check, plus Pyo's own details (name, logo, deploy form, databases)
in `x-pyo` fields. You can run it with `docker compose up`, and Pyo's agent turns
it into the Kubernetes objects, so templates need no Kubernetes knowledge.
Only a small part of Compose is allowed (no builds, host paths or privileged
settings), which is what makes them reviewable.

## Layout

```
templates/<id>/compose.yaml   the template
templates/<id>/logo.svg       its logo (optional)
schema.json                   what compose.yaml may hold (editors use it)
template.schema.json          what the build makes of it: one entry of index.json
catalog.yaml                  the order templates are listed in (maintainers only)
scripts/                      the converter, validator, build and digest pinner
```

## Commands

```bash
bun install
bun test            # the converter's and validator's own tests
bun run validate    # checks every template
bun run build       # writes dist/v1/index.json and the logos
bun run pin         # fills in missing image digests from the registries
```

`bun run pin --refresh` looks every digest up again, for when a tag moved.

To try a template on your machine:

```bash
docker compose -f templates/uptime-kuma/compose.yaml config   # is it valid Compose?
docker compose -f templates/uptime-kuma/compose.yaml up        # run it
docker compose -f templates/umami/compose.yaml --profile local up   # with its local database
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for writing one. Every change to a
template bumps its `x-pyo.version` (patch for an image bump, minor for a new
option, major for a breaking change): Pyo records it with each service.

## How Pyo uses this

`bun run build` converts each `compose.yaml` (`scripts/compose.ts`) into
`dist/v1/index.json`, plus the logos. On every push to `main`, CI publishes
`dist/` to GitHub Pages.

Pyo bundles a snapshot of that build: its `dash/scripts/sync-templates.ts`
copies `index.json` and the logos into the dashboard
(`dash/src/lib/pyo/catalog.json`), so templates work offline and on fresh
installs. The website
([pyo-web](https://github.com/upsetdev/pyo-web)) syncs from the same build. Pyo
only reads the JSON, so it never parses YAML or Compose files from the internet.

## Trademarks

Logos in `templates/` belong to their owners and identify the software each
template runs. They don't imply endorsement. Everything else is under the
[Apache License 2.0](./LICENSE).
