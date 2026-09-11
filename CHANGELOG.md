# Changelog

## 0.3.0

- OpenAI as a second critic: any vision-capable OpenAI model via the Responses API with
  strict structured outputs; reasoning effort from the thinking level; provider inferred
  from the model id or set with `provider`; built-in OpenAI prices; `models` and the cost
  ledger name the provider.
- Settled decisions: `ui-critic/decisions.md` closes rejected findings; each finding names
  the decision it would reopen and is withheld, with the count and the list in the report.
- Concurrency: pages and pairs run a few at a time (`concurrency`, default 3), checkpointed
  as they land, in capture order.
- Consensus on regressions: every reported regression gets a second, stricter look; only
  confirmed ones count, tagged measured or judged; `--fail-on measured` is the CI-safe gate.
- Runtime facts in the audit: console errors, uncaught exceptions, failed requests (requests
  the browser cancelled itself, such as abandoned prefetches, are not counted), HTTP errors
  and cumulative layout shift, with the prompt told to report them.
- Signed-in follow-ups: a page the critic asks for that redirects to sign in is captured
  again in the signed-in context when `auth` is configured.

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
