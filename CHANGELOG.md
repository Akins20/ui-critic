# Changelog

## 0.2.0

- Scenarios: click, hover, keyboard focus, fill, press, wait and scroll steps per route, each
  in a fresh browser context, reviewed as their own page; optional per-viewport scenarios.
- Signed-in capture: routes and scenarios marked `auth` run behind a login the tool performs
  from variables in the environment or a gitignored env file; literal passwords are refused.
- Mandatory brief, context files and an answers file; the critic can request pages, files,
  answers and measurements, and same-origin page requests are followed automatically.
- Measured facts per page: fonts, size histogram, headings, landmarks, alt coverage, small
  targets, WCAG contrast; text over images is reported as unmeasurable rather than failing.
- Fifteen design disciplines with per-page coverage and eight interaction principles, all
  configurable.
- Built-in Gemini price table with an as-of date, cost per run in every report, a `cost`
  command over the usage ledger, and per-model prices in `models`.
- Resilience: output budget escalation, per-page and per-pair checkpoints, resumable critiques
  and comparisons.
- Full-page captures hide bars fixed to the bottom edge so they are not painted over the footer.

## 0.1.0

- First release: capture, critique, compare, run and verify with explicit prefix caching,
  configurable thinking, and a usage ledger.
