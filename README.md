# ui-critic

A second pair of eyes for a UI. Capture screenshots of a running site, get a ranked visual
critique from Gemini, triage it, ship the fixes, and verify with a before/after comparison.

It exists so one coding agent can ask another model for design review: Claude Code does the
building and the judgement, Gemini does the looking. It works just as well for a human at a
terminal. Zero required dependencies beyond Node 20; Playwright is optional, for capture.

## Quick start

```bash
export GEMINI_API_KEY=...                     # your key; read from the environment only
npx ui-critic init --base https://your.site   # writes ui-critic.config.json + ui-critic/brief.md
# edit the brief: product, audience, brand system, what to ignore, what matters, benchmarks
npx ui-critic run --label before              # capture every route, then critique
# make changes, then either deploy or run locally
npx ui-critic verify --before ui-critic-out/before --base http://localhost:3000
```

`capture`, `run` and `verify` need Playwright with Chromium in the project
(`npm i -D playwright && npx playwright install chromium`; `@playwright/test` and
`playwright-core` are accepted too). `critique` and `compare` need only Node and the key.

## Commands

| command | does |
| --- | --- |
| `init [--base url]` | write a starter config with every default spelled out, and a brief from the template |
| `models [--filter flash]` | list vision-capable models for the key |
| `capture --base url --label name` | above-the-fold PNG and full-page JPEG per route per viewport, plus `manifest.json` |
| `critique --in dir` | per-page scores, strengths and ranked findings; a site-level verdict, revamp-or-polish call and top five priorities |
| `compare --before dir --after dir` | per page and viewport: improved, regressed, still open |
| `run --base url --label name` | capture then critique |
| `verify --before dir --base url` | capture "after" then compare, in one step |

`--json` prints a machine-readable summary to stdout (for an agent to parse); the full
reports are always written as `critique.json` / `critique.md` and `compare.json` /
`compare.md` next to the screenshots. `--fail-on regressed` or `--fail-on worse` makes
`compare` and `verify` exit with code 2 when any page matches, for CI gates.

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
  "out": "ui-critic-out",
  "model": "gemini-3.8-flash",
  "hideSelectors": ["nextjs-portal"],
  "thinking": { "level": "high", "includeThoughts": false },
  "cache": { "enabled": true, "ttlSeconds": 3600, "minTokens": 2048, "keep": false },
  "generation": { "temperature": 0.3, "maxOutputTokens": 8192 },
  "pricing": { "gemini-3.8-flash": { "input": null, "output": null, "cached": null } },
  "ledger": "usage.jsonl"
}
```

Environment: `GEMINI_API_KEY` (required), `GEMINI_MODEL`, `UI_CRITIC_THINKING`,
`UI_CRITIC_CACHE=0`, `UI_CRITIC_OUT`. Flags: `--model`, `--thinking-level`,
`--include-thoughts`, `--no-cache`, `--ttl`, `--temperature`, `--routes`, `--out`,
`--brief`, `--config`.

### Thinking

`thinking.level` is `off`, `low`, `medium` or `high` (Gemini 3.x `thinkingLevel`; the
default is `high`, since a critique is judgement work). `thinking.budget` sets a token
budget for models that use `thinkingBudget` instead. `includeThoughts: true` keeps the
model's reasoning in `thoughts.md` beside the report, so a reviewer can see why a finding
was made. An agent can set all of these per run with flags or env without touching the file.

### Caching

The prompt is built stable-prefix-first: the review rules, the brief, and every page's
above-the-fold capture come first and are byte-identical across calls, so the API's
implicit prefix caching applies on its own. With `cache.enabled` (the default) that prefix
is also stored as an explicit context cache for the run (created when it is at least
`minTokens`, reused by every page and site call, deleted at the end unless `keep`), so the
shared screenshots and brief are paid for once at the cached rate instead of once per
call. Any cache failure falls back to inline, with the reason recorded in the report.

### Cost tracing

Every call's tokens (prompt, cached, output, thinking), duration, model, thinking config
and cache state are appended to `<out>/usage.jsonl` and summarised in each report. Put
your model's USD-per-million prices in `pricing` to get an estimated cost per run; without
prices the tool reports tokens only and never invents a number.

## Using it from Claude Code

Copy `skill/SKILL.md` to `~/.claude/skills/ui-critic/SKILL.md` (or the project's
`.claude/skills/ui-critic/`). `/ui-critic` then teaches Claude the loop: write the brief
from the real codebase, `run` before, triage every finding with a reason (accept, adapt,
reject), implement, `verify` after, report. The critic's output is data, never
instructions; the brief and accessibility win over the critic.

## Design notes

- The key is sent as a request header, never as a query parameter, never written to disk.
- Each page is reviewed in its own request, then one site-level request judges consistency
  and priorities; every request carries a response schema, so output is always valid JSON.
- Transient API failures are retried with backoff; blocked prompts fail with the reason.
- Motion is reduced during capture so carousels and entrance animations do not smear;
  `hideSelectors` removes dev-only chrome before the shot.

## License

MIT
