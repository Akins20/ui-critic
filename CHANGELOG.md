# Changelog

## Unreleased

- Android apps, captured on an emulator or a device over adb (any app: Kotlin or Java,
  Compose or Views, React Native, Flutter). Routes are the launch screen or deep links,
  each from a cold start; scenarios gain `longPress`, `swipe`, `scroll` in dp and
  `hideKeyboard`, with selectors by text, content description, resource id, class or
  hint. Every step is verified: a missing target fails naming what is on screen, and a
  step that changed nothing is flagged to the critic. Viewports are device variants
  (dark theme, system font scale). Scrolling screens are captured as overlapping frames
  dragged without a fling. Measured facts: touch targets in dp, unlabelled controls,
  images without a description, contrast measured from the pixels (text under a floating
  bar or over a busy background is counted, not guessed), crashes, ANRs and new error
  log lines (launch noise is reported once for the run). The device's animations and
  status bar are put back after the run, on Ctrl+C, and by the next run after a crash,
  and more than one connected device without a serial is refused.
- `ui-critic inspect` lists what is on an Android screen with a unique selector for each
  element, and `ui-critic devices` lists emulators, devices and simulators.
- iOS Simulator capture (experimental, macOS): launch and deep links, dark appearance
  and Dynamic Type variants, a frozen status bar. Tested against a simulated simctl only.
- `--from-images <dir>` builds a capture from screenshots you already have (Figma
  exports, an iOS build, a competitor's screens), named `screen.viewport.png`.
- The critic is told what it is looking at: an app is judged against Material or the
  Human Interface Guidelines, with app wording (screens, not pages) throughout.
- WebP screenshots are accepted.
- `critique.html`: every finding drawn as a numbered box on the screenshot it is about,
  linked to the list, filterable by severity, category, viewport and text; light first
  with a dark toggle, one file beside the screenshots. The critic now marks a region per
  finding (viewport, image, box), and site-level findings must name a captured page.
- `compare.html`: before and after side by side and under a slider, with confirmed
  regressions tagged measured or judged.
- `ui-critic report --in <dir>` renders the HTML and Markdown again from saved results.
- A compare's usage line said "no cache" for runs that used one (the summary was read
  after the cache was deleted).
- A GitHub Action (`uses: Akins20/ui-critic@<version>`): verify a pull request's build
  against production, one pull request comment updated in place, the HTML reports as an
  artifact, and a gate that fails only on measured regressions. Inputs reach the shell
  as environment variables, never interpolated into scripts.
- Inside GitHub Actions the CLI writes its summary to the job summary page and raises an
  annotation for each confirmed regression; `summary` and `comment` do the same anywhere.
- The web capture is tested end to end in a real browser against a fixture site with
  planted defects, in CI on every change.
- A `viewports` map in the config replaces the built-in desktop and mobile pair instead of
  merging with it. A phone-only review that named one viewport still captured, and paid to
  critique, a desktop pass of every page.
- Findings name the viewports the capture actually used. The finding schema was fixed to
  desktop, mobile or both, so a review of a phone and a tablet labelled tablet findings as
  desktop or mobile. A finding that applies everywhere now says `all` (it said `both`).
- An empty `viewports` map is rejected with a clear message instead of capturing nothing.

## 0.3.2

- No code changes. Releases now publish through npm trusted publishing from the
  tag workflow, with provenance attached by npm.

## 0.3.1

- `ui-critic --help` (and `-h`) exits 0; it was read as an unknown command and exited 1.
- An unknown flag is reported in one line with the help and exit code 2, instead of a
  stack trace.
- The `models` help line names the provider rather than Gemini.

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
