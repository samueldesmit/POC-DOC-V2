# Strix Kickstarter Theme

A Shopify theme based on the Strix Kickstarter framework, focusing on simplicity, performance, and a great developer experience.

## Getting started

### Tools

- [VS Code](https://code.visualstudio.com/)
- [Shopify CLI](https://shopify.dev/themes/tools/cli/installation)

### Setup

1. Clone the repository
2. Install recommended VS Code extensions (`CMD + SHIFT + P` → Show recommended extensions)
3. Install dependencies `npm install`
4. Start the development server `npm run dev` (or `npm run watch` and `npm run build`)
5. Start the Shopify CLI `npm run start`

### Usage of branches

1. Pull the latest changes from main with `git pull origin main`
2. Create a new branch with `git checkout -b {branch-name}` (use `feature/`, `fix/`, `bug/` prefixes)
3. When done, squash all commits into 1 or amend your changes and use `git push origin {branch-name} --force-with-lease`

## Design tokens

Brand values live in one file, `design-tokens.json` at the theme root, in the [Strix design-token standard](https://github.com/webweit-gmbh/strix-shopify-design/blob/main/docs/design-token-standard.md) (W3C DTCG with Kickstarter's own names). After changing it, run:

```sh
npm run tokens
```

It writes three files, which you commit:

| File | What it gets |
|---|---|
| `src/assets/tailwind/tokens.css` | Palettes (`surface-*`, `brand-*`, named colours), `font-heading` / `font-body`, screens `sm`–`5xl`, radii, easing, section padding (`--desktop-padding-*`, `--mobile-padding-*`) and focus-ring variables |
| `src/assets/tailwind/base/typography.js` | The type classes (`heading-2xl` … `heading-3xs`, `body`, `description-*`, `button`, `link`, `price-list-regular`), mobile size and `md` size |
| `config/settings_data.json` | The colour schemes (all 16 keys) shown as defaults in the theme editor |

`npm run tokens:check` fails when the generated files are out of date; CI runs it before the build. The default file reproduces Kickstarter's own look exactly. A client theme gets its file from the Strix design portal (Export for Shopify, or the `/sb:design-system` command of the sb plugin), from Figma or by hand. Every colour scheme outputs all 16 keys as CSS variables (`--color-arrows`, `--color-info`, …) with matching Tailwind colours (`text-arrows`, `bg-disabled-background`, `text-error`, …).

The script warns when a template still uses a colour scheme id that the file no longer defines. Existing themes are not affected until they adopt the file.

## Deploying

Thanks to the [Shopify GitHub integration](https://shopify.dev/docs/themes/tools/github), deploying is as easy as merging to the linked branch.

Assets are automatically built by [GitHub Actions](.github/workflows/build.yml).

## Version bumping

Version is automatically incremented on every push to `main` via [GitHub Actions](.github/workflows/auto-version-bump.yml). This updates:
- `package.json`
- `config/settings_schema.json` (theme_version)

## Creating a PR

1. Ensure the branch meets all acceptance criteria of the ticket
2. Squash all commits into 1 commit
3. Connect your branch to the Shopify store and disconnect from GitHub
4. Create Editor and Preview links for the reviewer:
   - Preview: `{store-name}.myshopify.com/?preview_theme_id=THEME_ID`
5. Recreate the feature as designed in Figma with the same assets
6. Assign yourself to the PR and add the `Review request` label
