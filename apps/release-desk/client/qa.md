# Release Desk client validation

Checked 12 November 2026 using Chrome through CUA. This is local development fixture validation, not evidence of a live Shopify installation, Claude review, CI run, or GitHub merge.

- Viewports: 1440 × 900, 768 × 1024, 390 × 844. No horizontal overflow. Tablet retains inbox/detail; mobile switches between them. Viewport reset after QA.
- Stale review disables merge. Starting a fixture test shows background progress and disables merge, then polling displays passed evidence.
- Setup, failed review, and read-only access disable merge. Failed findings open visibly with file and line context.
- Unknown merge exposes Check merge outcome. Fixture reconciliation never merges, returns a failed run, and permits a fresh test while merge remains disabled.
- Native confirmation identifies PR, exact commit, destination branch, review run and deployment effect. Escape closes it and returns focus to its trigger.
- Empty inbox, service error, and missing Shopify session states verified. Without explicit fixture query, local app stays blocked.
- No browser error or warning logs observed during QA.
- Production build passed. Fixture adapter, fixture records, and fixture banner absent from bundled JavaScript. App Bridge CDN and API-key placeholder retained in built HTML.
- Taste lint: 0 failures; one intentional shadow on the modal overlay.

Screenshots are in `.taste-skill/qa/`: desktop-ready.jpg, desktop-merge-confirmation.jpg, desktop-setup.jpg, tablet-ready.jpg, mobile-inbox.jpg, mobile-detail.jpg, session-required.jpg.

## Simulated reviewer mode

Additional CUA check after introducing server-controlled reviewMode=demo:
- Persistent Demo reviews disclosure; every reviewer result labeled Simulated Claude output / Simulated approval.
- Run endpoint polled every two seconds while queued/running, separately from the 15-second inbox poll. Actual persisted reviewer states drive progress; no client-created review verdicts or percentages.
- Observed Security complete, Correctness simulating, Maintainability waiting, CI running; then three simulated approvals and ready confirmation.
- Merge modal includes Demo review evidence and explicit no-AI-review language. Production copy distinguishes real GitHub CI and real manual merge; local fixture copy identifies simulated external actions.
- Reduced-motion CSS disables spinner/pulse animation. Existing viewport sizing unchanged in this verification.
- No browser errors/warnings. Build and diff checks passed; taste lint 0 failures / one intentional modal shadow warning.
- Development fixture adapter remains absent from production build. Server-controlled production demo labels are retained.
- Screenshots: `.taste-skill/qa/demo-review-progress.jpg`, `.taste-skill/qa/demo-merge-confirmation.jpg`.
