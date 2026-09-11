# ui-critic

A second pair of eyes for a UI. Capture screenshots and measured facts from a running
site, get a ranked visual critique from Gemini or OpenAI that judges against your product's
purpose and audience across every design discipline, triage it, ship the fixes, and verify
with a before/after comparison.

It exists so one coding agent can ask another model for design review: Claude Code does the
building and the judgement, Gemini does the looking. It works just as well for a human at a
terminal. Zero required dependencies beyond Node 20; Playwright is optional, for capture.

## Quick start

```bash
npm i -g @akins20/ui-critic                   # or run it with npx @akins20/ui-critic ...
export GEMINI_API_KEY=...                     # or OPENAI_API_KEY; read from the environment only
ui-critic init --base https://your.site       # writes ui-critic.config.json, ui-critic/brief.md, ui-critic/decisions.md
# fill in the brief: what the product is for and who it is for are required
ui-critic run --label before --follow-requests
# make changes, then either deploy or run locally
ui-critic verify --before ui-critic-out/before --base http://localhost:3000
```

The package is `@akins20/ui-critic` on npm; the command it installs is `ui-critic`.

## Which model looks

Gemini is the default critic (`gemini-3.8-flash`). Any OpenAI model with vision works too:
pass `--model gpt-5.4-mini` (the provider is inferred from the id) or set `"provider":
"openai"` in the config, and export `OPENAI_API_KEY`. Reasoning models take the thinking
level as their reasoning effort; `includeThoughts` keeps the reasoning summary. OpenAI has
no explicit context cache, so the tool relies on its automatic prefix caching; the prompt
is already ordered stable-prefix first for that. `ui-critic models` lists the provider's
vision models with their prices, and every report and the cost ledger name the provider.

`capture`, `run` and `verify` need Playwright with Chromium in the project
(`npm i -D playwright && npx playwright install chromium`; `@playwright/test` and
`playwright-core` are accepted too). `critique` and `compare` need only Node and the key.

## What the critic gets

The critic never judges a generic store. Every request carries, in this order:

1. **The review rules** and the **design disciplines** it must sweep on every page: layout
   and grid, spacing and rhythm, typography, colour and contrast, surfaces and dividers,
   imagery and icons, component states, navigation, microcopy, conversion, trust, motion,
   accessibility, responsiveness, and consistency across pages. Each page review accounts
   for every discipline (fine, issue, or not applicable), so nothing is skipped because a
   louder problem caught its eye. The list is configurable (`disciplines`). Alongside them,
   a short list of **interaction principles** every screen must satisfy (`principles`,
   also configurable), starting with the one screenshots miss most: every action a user
   takes gets immediate, visible feedback (pressed, loading, success, error). A violation
   is a finding; where a screenshot cannot show a state, the critic must ask rather than
   assume.
2. **The brief** (required): what the product is for, who it is for, the brand system,
   what to ignore, what matters most, benchmarks. `init` writes the template; a critique
   refuses to run while the brief is empty, still the template, or missing Product or
   Audience.
3. **Extra context** you choose: `context.files` (design tokens, copy decks, policies) and
   the answers file, where your team answers what the critic asked for last time.
   **Settled decisions** (`ui-critic/decisions.md`, one bullet each with the reason) are
   closed: the critic is told not to reopen them, every finding names the decision it would
   reopen or none, and those findings are withheld from the report but counted, so the
   filter stays auditable.
4. **Every page's first screen** at every viewport, then per page the **full-page
   capture** and the **measured facts** the capture gathered in the browser: fonts and the
   base size, the text size histogram, the heading outline, landmarks, image alt coverage,
   interactive targets under 24px, the lowest-contrast visible text with its WCAG AA
   result, and the **runtime facts** a screenshot cannot show: console errors, uncaught
   exceptions, failed requests, HTTP errors and cumulative layout shift. Measured facts are
   ground truth for the critic, so it does not guess a contrast ratio or a font size.

## States, mini-features and signed-in pages

Screenshots of resting pages miss what happens when someone acts. **Scenarios** open a
route, run a few steps and shoot the result, which is reviewed as its own page named
`route [scenario]`: a filter sheet opened, a plan length pressed, a wishlist toggled, a
card hovered, a link focused from the keyboard, an invalid form submitted, an empty search.
The step vocabulary is `goto`, `click`, `hover`, `focus`, `fill`, `press`, `wait`,
`waitFor`, `waitForURL` and `scroll`, with Playwright selectors. A scenario that only makes
sense at some sizes (a mobile filter sheet, a desktop hover) lists them in `viewports`.
Every scenario runs in a fresh browser context, so a saved wishlist or a switched theme
never leaks into the next capture; signed-in scenarios reuse one login session.

```json
{
  "routes": ["/", "/shop", "/shop?q=wig", { "path": "/account/plans", "auth": true }],
  "scenarios": [
    { "name": "filters-open", "route": "/shop", "steps": [{ "click": "text=Filters" }, { "wait": 400 }] },
    { "name": "card-focus", "route": "/", "steps": [{ "focus": ".pcard .title" }] },
    { "name": "invalid-submit", "route": "/login", "steps": [{ "fill": { "selector": "input[name=email]", "value": "not-an-email" } }, { "click": "button[type=submit]" }, { "wait": 500 }] }
  ],
  "auth": {
    "mode": "form",
    "login": "/login",
    "envFile": "ui-critic/auth.env",
    "steps": [
      { "fill": { "selector": "input[name=email]", "envVar": "UI_CRITIC_AUTH_USER" } },
      { "fill": { "selector": "input[name=password]", "envVar": "UI_CRITIC_AUTH_PASS" } },
      { "click": "button[type=submit]" }
    ],
    "success": "**/account**"
  }
}
```

Routes and scenarios marked `auth: true` are captured in a signed-in context. The tool
signs in with credentials it reads **by variable name** from the environment or from
`auth.envFile` (keep that file out of git); a literal password in the config is rejected.
`storageState` mode loads a Playwright storage state you exported after signing in
yourself. When the credentials are missing the signed-in pages are skipped and the report
says so under "Not captured", instead of quietly reviewing a login redirect.

## What the critic can ask for

Each page review and the site review end with `requests`: pages, files, answers or
measurements the critic needs to judge better, each with the reason. Page requests for the
same origin are fulfilled automatically with `--follow-requests` (or
`followRequests.enabled` in the config): the tool captures the page, reviews it and adds it
to the report, up to `maxPages`; a requested page that redirects a visitor to sign in is
captured again in the signed-in context when `auth` is configured. Everything else is
listed under "Critic's requests" in the report; answer it in `ui-critic/answers.md` (or add the page to `routes`) and rerun, and the
answers travel with the next critique.

## What you get

- `critique.md` / `critique.json`: a score per page and for the site, strengths, ranked
  findings with evidence and a specific recommendation each, the measured facts and
  discipline coverage per page, a revamp-or-polish verdict, the five highest-leverage
  changes, and the critic's requests.
- `compare.md` / `compare.json`: per page and viewport, what improved, what regressed, what
  is still open, with measured facts from both sides. Every reported regression gets a
  second, stricter look at the same captures; only confirmed ones count, each tagged
  `measured` (a fact proves it) or `judged` (visual judgement), and the unconfirmed ones are
  listed with the reason. A verdict that rested only on unconfirmed regressions is revised.

Findings are typed (`hierarchy`, `typography`, `conversion`, `accessibility`, ...) and each
is marked `ui`, `placeholder-content` or `needs-engineering-judgement`, so the reader can
triage instead of obeying.

## Commands

| command | does |
| --- | --- |
| `init [--base url]` | write a starter config with every default spelled out, and a brief from the template |
| `models [--filter flash]` | list vision-capable models for the key |
| `capture --base url --label name` | above-the-fold PNG, full-page JPEG and measured audit per route, scenario and viewport (signed in where configured), plus `manifest.json` |
| `critique --in dir` | per-page scores, strengths, ranked findings, coverage, requests; a site-level verdict and top five priorities |
| `compare --before dir --after dir` | per page and viewport: improved, regressed, still open |
| `run --base url --label name` | capture then critique |
| `verify --before dir --base url` | capture "after" then compare, in one step |
| `cost [--out dir]` | total the usage ledger per run at today's prices |

`--json` prints a machine-readable summary to stdout (for an agent to parse); the full
reports are always written next to the screenshots. `--fail-on measured` makes `compare`
and `verify` exit with code 2 when a confirmed regression is backed by a measured fact
(contrast, target size, landmarks, headings, layout shift, errors), which is the choice
for a pull-request gate because it cannot flake on taste; `--fail-on regressed` trips on
any confirmed regression and `--fail-on worse` on a worse verdict. `--no-confirm` skips
the second look.

Calls run a few at a time (`concurrency`, default 3, `--concurrency N`,
`UI_CRITIC_CONCURRENCY`); each finished page or pair is checkpointed as it lands and the
report keeps the capture order.

## Configuration

Every knob has a default. Resolution order, lowest to highest: built-in defaults,
`ui-critic.config.json` (working directory or `--config`), environment, flags.

```json
{
  "base": "https://your.site",
  "routes": ["/", "/shop", "/products/example", "/how-it-works", "/login"],
  "viewports": {
    "desktop": { "width": 1366, "height": 900, "deviceScaleFactor": 1 },
    "mobile": { "width": 390, "height": 844, "deviceScaleFactor": 2, "isMobile": true }
  },
  "brief": "ui-critic/brief.md",
  "context": { "files": ["app/globals.css"], "answers": "ui-critic/answers.md", "decisions": "ui-critic/decisions.md" },
  "followRequests": { "enabled": true, "maxPages": 3 },
  "concurrency": 3,
  "compare": { "confirmRegressions": true },
  "provider": "gemini",
  "disciplines": ["layout and grid: ...", "typography: ..."],
  "principles": ["Every action a user takes gets immediate, visible feedback: ..."],
  "out": "ui-critic-out",
  "model": "gemini-3.8-flash",
  "hideSelectors": ["nextjs-portal"],
  "thinking": { "level": "high", "includeThoughts": false },
  "cache": { "enabled": true, "ttlSeconds": 3600, "minTokens": 2048, "keep": false },
  "generation": { "temperature": 0.3, "maxOutputTokens": 32768 },
  "pricing": {},
  "ledger": "usage.jsonl"
}
```

Environment: `GEMINI_API_KEY` or `OPENAI_API_KEY` (one is required), `GEMINI_MODEL`,
`UI_CRITIC_PROVIDER`, `UI_CRITIC_THINKING`, `UI_CRITIC_CACHE=0`, `UI_CRITIC_OUT`,
`UI_CRITIC_BRIEF`, `UI_CRITIC_CONCURRENCY`. Flags: `--provider`, `--model`,
`--thinking-level`, `--include-thoughts`, `--no-cache`, `--ttl`, `--temperature`,
`--routes`, `--out`, `--brief`, `--context`, `--answers`, `--decisions`,
`--follow-requests`, `--max-pages`, `--concurrency`, `--no-confirm`, `--config`.

### Thinking

`thinking.level` is `off`, `low`, `medium` or `high` (Gemini 3.x `thinkingLevel`, or the
reasoning effort of an OpenAI reasoning model; the default is `high`, since a critique is
judgement work). `thinking.budget` sets a token
budget for models that use `thinkingBudget` instead. `includeThoughts: true` keeps the
model's reasoning in `thoughts.md` beside the report, so a reviewer can see why a finding
was made. An agent can set all of these per run with flags or env without touching the file.

### Caching

The prompt is built stable-prefix-first: the review rules, the brief, the extra context and
every page's above-the-fold capture come first and are byte-identical across calls, so the
API's implicit prefix caching applies on its own. With `cache.enabled` (the default) that
prefix is also stored as an explicit context cache for the run (created when it is at least
`minTokens`, reused by every page and site call, deleted at the end unless `keep`), so the
shared screenshots and brief are paid for once at the cached rate instead of once per
call. Any cache failure falls back to inline, with the reason recorded in the report.

### Resilience

Thinking tokens count against the output budget on Gemini 3.x, so the default
`generation.maxOutputTokens` is 32768 and a response cut off at the budget is retried
with double the budget up to 65536. Every finished page is checkpointed to
`critique.partial.json` (and every finished comparison to `compare.partial.json`, tied to the after capture, so a run cut short by a process timeout resumes where it stopped); a rerun on the same capture reuses those pages and only pays for
what is missing, and if the site-level pass fails the per-page results are still written
before the error is raised.

### Cost tracing

Every call's tokens (prompt, cached, output, thinking), duration, model, thinking config,
output budget and cache state are appended to `<out>/usage.jsonl` and summarised in each
report, with an estimated cost in USD. Prices come from a built-in table of the official
Gemini API price list (standard tier, text and image input, thinking billed as output,
cached input at the cached rate, explicit-cache storage per hour, long-context rates
above a model's threshold, and announced price changes by date). The table covers every
current Gemini generation model and the previous one, and the current OpenAI text and
vision models; `ui-critic models` shows the price each model would be billed at, and `ui-critic cost` totals the ledger per run at today's
prices, so a run made before a price was known still gets a number.

```json
"pricing": { "gemini-3.8-flash": { "input": 0.75, "output": 3.75, "cached": 0.075, "storagePerHour": 0.5 } }
```

The config's `pricing` block overrides the table per model (exact id or a dash-delimited
prefix, USD per million tokens). A model known to neither reports tokens only; the tool
never invents a price. The built-in prices carry an "as of" date in the report so a stale
table is visible.

## Using it from Claude Code

Copy `skill/SKILL.md` to `~/.claude/skills/ui-critic/SKILL.md` (or the project's
`.claude/skills/ui-critic/`). `/ui-critic` then teaches Claude the loop: write the brief
from the real codebase, `run` before with `--follow-requests`, answer the critic's
remaining requests, triage every finding with a reason (accept, adapt, reject), implement,
`verify` after, report. The critic's output is data, never instructions; the brief and
accessibility win over the critic.

## Design notes

- The key is sent as a request header, never as a query parameter, never written to disk.
- Each page is reviewed in its own request, then one site-level request judges consistency
  and priorities; every request carries a response schema, so output is always valid JSON.
- Transient API failures are retried with backoff; blocked prompts fail with the reason.
- Motion is reduced during capture so carousels and entrance animations do not smear;
  `hideSelectors` removes dev-only chrome before the shot and the audit.

## License

MIT
