## Which app and why

<!-- The app, a link to its repository, and why it belongs here: is it
popular, maintained, and does its licence allow it? -->

## Checklist

- [ ] `templates/<id>/compose.yaml` with `x-pyo` passes `bun run validate` and `bun test`
- [ ] Images are pinned by digest with `bun run pin`
- [ ] `x-pyo.version` is `1.0.0` for a new template, or bumped for a change
- [ ] Built-in databases the app needs are declared in `x-pyo.database` (or `databases`), not as deployed services
- [ ] `logo.svg` is included and the project allows its use (or there's no logo)
- [ ] Tried with `docker compose --profile local up` (see [Testing locally](https://github.com/upsetdev/pyo-templates/blob/main/CONTRIBUTING.md#testing-locally))
- [ ] Deployed on Pyo and the web UI answers

## What you checked on Pyo

<!-- Pyo version, what you opened or signed in to, anything that needed a
manual step after deploying. -->
