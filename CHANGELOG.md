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
- Benchmarks (`ui-critic benchmark`): competitors mapped route by route, captured at
  your viewports and compared for your audience (ahead, level or behind; what to adopt
  and how; what you do better; what not to copy), in benchmark.html.
- A page that answers with a bot check is recognised during capture and never judged:
  critiques list it under "Not captured", comparisons and benchmarks under "Not
  compared". Found when a competitor served Cloudflare's check to the phone viewport.
- critique and compare are now tested end to end against a simulated API.
- Try-on (`ui-critic tryon`): lay CSS over the live pages of a capture and see each
  version beside the original in tryon.html, from a CSS file or from directions the
  critic drafts for a goal using the page's own custom properties. Each page gets the
  measured share of changed pixels, what changed, whether it serves the goal, gains and
  losses, and the critic picks a direction. The CSS outranks the page's own and stays
  last through framework hydration; CSS from the critic is sanitised.
- Accessibility variants: viewports can set `zoom`, `textSpacing`, `forcedColors` and
  `vision`, and `--a11y` adds 320px reflow, 200% zoom, text spacing, forced colours,
  deuteranopia and dark; the critic is told what each tests. Every web capture now
  measures sideways scrolling, elements off the edge and cut-off text, against the
  device's layout width (a phone widens innerWidth to fit overflow, which hid it).
- The lint gains a colour-vision rule (colours that collapse for protanopia,
  deuteranopia or tritanopia), counts the page background, leaves variants out, and
  lints a dark theme against its own tokens.
- Interaction sweep on desktop viewports: every control hovered and compared with its
  rest look, and the page walked with Tab for visible focus (WCAG 2.4.7), invisible
  stops, backward jumps (WCAG 2.4.3), skip links, traps and positive tabindex. Every
  "no feedback" verdict is confirmed by comparing photographs, so a ring drawn by a
  wrapper is never reported as missing. Works on pages with a strict CSP. `--no-sweep`.
- Design-system lint (`ui-critic lint`, free): web captures record the style inventory
  and the page's own tokens; the lint reports token drift (CIEDE2000), off-palette and
  look-alike colours, type sizes off the scale and sprawl, too many families, cramped
  line height, long lines, spacing off the grid, radius and shadow sprawl, with proposed
  scales. `critique` runs it, gives the numbers to the site pass, and shows a Design
  system section with swatches in critique.html. `--fail-on lint` gates CI.
- Under Git Bash a route like `/` arrived as `C:/Program Files/Git/` and the capture
  opened nothing; such routes are restored, and a Windows path given as a route is
  refused with the reason.
- `npx uicritic` runs the tool: `npx ui-critic` reached a different package that owns
  the unscoped name. The package now also installs a `uicritic` command, and a small
  `uicritic` package (published beside this one, at the same version) points at it.
- A `viewports` map in the config replaces the built-in desktop and mobile pair instead of
  merging with it. A phone-only review that named one viewport still captured, and paid to
  critique, a desktop pass of every page.
- Findings name the viewports the capture actually used. The finding schema was fixed to
  desktop, mobile or both, so a review of a phone and a tablet labelled tablet findings as
  desktop or mobile. A finding that applies everywhere now says `all` (it said `both`).
- An empty `viewports` map is rejected with a clear message instead of capturing nothing.
- Score trends (`ui-critic trend`, free): every critique appends a line to
  `<out>/trend.jsonl`, and the command prints the score per run, how it moved, and
  the counts that do not drift beside it, overall or for one route. It says plainly
  that a score is judgement and should be read as a direction.
- Storybook (`--storybook <url>`): the stories of a running Storybook become the
  routes, so components are reviewed in isolation with everything the tool already
  does (measured facts, the lint, the hover and keyboard sweep, the critic, compare).
  Each story renders alone at `/iframe.html` and is named by its own title in the
  reports and its screenshot. The index is read from `index.json`, or `stories.json`
  on Storybook 6; docs pages are left out. One story per component by default,
  `--stories` to name components, `--all-stories` for every one, with a cap that
  reports what it left out. `ui-critic stories` lists them without capturing.
- A route can carry a name of its own, used in every report and in the screenshot's
  file name instead of the URL.
- Fidelity against the design (`ui-critic fidelity`): the Figma frames a screen was
  built from, read over the REST API with a token from `FIGMA_TOKEN`. Two checks at
  once: the frame's own values (fills, font sizes, radii, auto-layout spacing,
  shadows) against what the page renders, free and measured, separating drift from a
  value never rendered and one never designed; and the frame beside the screen for
  the critic, told that real content, an undrawn state and a deliberate improvement
  are not failures. Screens pair with frames by name and viewport, or by a map in the
  config, and what stays unpaired is listed on both sides. A frame holding far less
  than the page renders is called out as partial or out of date. The pixel comparison
  names where the screen sits furthest from the frame and deliberately gives no score.
  Only the shallow file index is fetched, not the whole document.
- A report's pictures went missing on Windows when a capture recorded from a short
  8.3 path ("ELIJAH~1.OGU") was rendered from the long one: the same folder, but the
  image got a path climbing out to the drive root. Affected every HTML report.
- Store screenshots and social cards (`ui-critic assets`): the screens a review already
  captured, rendered at Google Play, App Store 6.7-inch and 1200x630 social sizes as
  HTML photographed in the capture browser, so no design tool or image library is
  needed. Captions come from the config or are drafted by the critic from the brief.
  The background is a brand token where there is one; an app has no stylesheet, so
  the colour is measured from the screenshots, greys dropped by chroma and one accent
  drawn at several lightnesses merged into one family, named by its most vivid shade.

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
