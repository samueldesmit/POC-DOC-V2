# Release Desk

An embedded Shopify app that lets a merchant release their own theme changes safely. Every change is a pull request. The merchant tests it, opens a preview on an unpublished copy of the live store, merges it into `staging`, checks the staging theme, and then releases `staging` to `main` (live). Nobody needs a GitHub account; the app acts through its own GitHub App.

Based on an earlier Strix Release Desk prototype, made generic for a Strix kickstarter theme repository: one store and one repository per deployment, both set in environment variables, and a two-step flow (staging, then live) instead of a direct merge to `main`.

## The flow

```
feature branch ──PR──▶ staging ──release PR──▶ main
   │                     │                      │
   Test changes          Staging theme          Live theme
   Store preview         (GitHub-connected,     (GitHub-connected,
   Merge to staging       unpublished)           published)
```

1. A change arrives as a pull request into `staging` (made by a developer, or later by Claude on the merchant's request).
2. **Test changes** runs CI (build, theme check, the app's own regressions) and three Claude reviewers (security, correctness, maintainability) for that exact commit. In `demo` mode the reviewers are simulated and clearly labelled as such.
3. **Generate preview** uploads the PR as an unpublished theme named `Release Desk PR <n>`, with the live store's content (templates, section groups, settings, locales) laid over it, and links to it.
4. **Merge to staging** is enabled only when the latest run for the current head and base passed. The staging theme follows the `staging` branch through the Shopify GitHub integration.
5. **Prepare release** opens one PR from `staging` into `main`. It goes through the same Test and Merge steps. Merging it updates `main`, which the live theme follows.

Only `staging` itself can be merged into `main`; a PR from any other branch into `main` is refused by the app and by the review workflow.

## What runs where

| Part | Where |
| --- | --- |
| `client/` | React UI, built by Vite, embedded in the Shopify admin with App Bridge session tokens |
| `server/` | Express API, GitHub webhook, background worker, SQLite (`DATA_DIR`) |
| `.github/workflows/review-pr.yml` | Trusted review workflow, dispatched by the app from the PR's target branch |
| `.github/scripts/` | Request validation and the isolated (Docker) test and build runner |
| `.github/workflows/build.yml` | Kickstarter: compiles `assets/` on every PR and commits them back |

The app never publishes a theme. It merges pull requests; Shopify's GitHub integration does the rest.

## Setup per store

1. **Branches.** Create `staging` from `main`.
2. **Themes.** In the store: Online Store, Themes, Add theme, Connect from GitHub. Connect `main` (publish it as the live theme when ready) and `staging` (keep unpublished).
3. **GitHub App.** Create one, install it on this repository only. Repository permissions: Pull requests write (the app opens the release PR), Contents write, Actions write, Checks write, Administration read, Metadata read. Webhook URL `https://<host>/webhooks/github`, events `pull_request`, `workflow_run`, `check_run`, `push`.
4. **Branch protection** on both `staging` and `main`: require status check `Release Desk` pinned to the GitHub App, require branches to be up to date, enforce for administrators. The app shows a setup warning until this is in place.
5. **Shopify app.** Create it in the Dev Dashboard, fill in `shopify.app.toml` (client id, host), install it on the store. No Admin API scopes are needed.
6. **Previews (optional).** Install Shopify's Theme Access app on the store and create a password for `SHOPIFY_THEME_TOKEN`.
7. **Hosting.** Any Docker host with a persistent volume on `/data` and one replica (the Dockerfile and `railway.toml` work on Railway). Set the variables from `.env.example`.

Repository variables `STAGING_BRANCH` and `LIVE_BRANCH` (Settings, Secrets and variables, Actions) are only needed when the branches are not called `staging` and `main`; keep them equal to the app's values.

## Local development

Node 22.20 or newer. From `apps/release-desk`:

```sh
npm ci
npm test
npm run build
npm run dev   # UI only: http://127.0.0.1:5173/?fixture=1
```

The fixture shows illustrative data and makes no Shopify or GitHub calls. For the server: create `.env` from `.env.example` and run `node --env-file=.env --watch server/index.mjs`.

## Limits and safety

- One store and one repository per deployment, fixed at boot. Webhooks from other repositories are rejected.
- At most 80 changed files and a 200 KB diff per review; binary or truncated patches fail closed.
- Candidate code builds and tests only inside restricted containers without credentials; theme check runs with Shopify's recommended config, so a PR cannot load its own check code.
- Previews: at most ten `Release Desk PR` themes per store. Remove old ones in the admin to make room.
- A merge whose outcome GitHub does not confirm is blocked until **Check merge outcome** has read GitHub's recorded result; the app never retries a merge by itself.

## Not built yet

- Making a change from the app ("ask Claude"). For now a pull request into `staging` comes from a developer or Claude Code.
- Cleaning up preview themes after a PR closes.
