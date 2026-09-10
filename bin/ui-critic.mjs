#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadConfig, init } from "../src/config.mjs";
import { capture } from "../src/capture.mjs";
import { critique } from "../src/critique.mjs";
import { compare } from "../src/compare.mjs";
import { listModels } from "../src/gemini.mjs";
import path from "node:path";
import { usageLine } from "../src/report.mjs";
import { costReport, renderCostReport } from "../src/cost.mjs";
import { resolvePrice, describePrice, PRICING_AS_OF, PRICING_SOURCE } from "../src/pricing.mjs";

const HELP = `ui-critic: a second pair of eyes on a UI, for coding agents and humans.

Commands
  init       [--base <url>]                          write a starter ui-critic.config.json and brief
  models     [--filter flash]                        list vision-capable Gemini models
  capture    --base <url> --label <name>             screenshot and measure every route at every viewport
  critique   --in <capture dir>                      ranked findings, scores, priorities, the critic's requests
  compare    --before <dir> --after <dir>            what improved, regressed, is still open
  run        --base <url> --label <name>             capture then critique, in one go
  verify     --before <dir> --base <url> [--label after]   capture "after" then compare
  cost       [--out <dir>]                           total the usage ledger per run at today's prices

The brief (ui-critic/brief.md by default) is required for critique, compare, run and
verify: it tells the critic what the product is for and who it is for.

Options (flags win over env, env over ui-critic.config.json, file over defaults)
  --config <file>  --routes /,/shop  --out <dir>  --brief <file>  --model <id>
  --context <file,file>   extra files for the critic (tokens, copy, policies)
  --answers <file>        answers to the critic's earlier requests (default ui-critic/answers.md)
  --follow-requests [--max-pages N]   capture and review same-origin pages the critic asks for
  --thinking-level off|low|medium|high   --include-thoughts   --no-cache   --ttl <seconds>
  --temperature <0..2>   --json (machine-readable summary on stdout)
  --fail-on regressed|worse   (compare/verify: exit 2 when any page matches)

Environment: GEMINI_API_KEY (required, never stored), GEMINI_MODEL, UI_CRITIC_THINKING,
UI_CRITIC_CACHE=0, UI_CRITIC_OUT, UI_CRITIC_BRIEF.
`;

const [cmd, ...rest] = process.argv.slice(2);
const { values: flags } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    base: { type: "string" },
    label: { type: "string" },
    routes: { type: "string" },
    out: { type: "string" },
    config: { type: "string" },
    brief: { type: "string" },
    context: { type: "string" },
    answers: { type: "string" },
    "follow-requests": { type: "boolean" },
    "max-pages": { type: "string" },
    model: { type: "string" },
    in: { type: "string" },
    before: { type: "string" },
    after: { type: "string" },
    filter: { type: "string" },
    "thinking-level": { type: "string" },
    "include-thoughts": { type: "boolean" },
    "no-cache": { type: "boolean" },
    ttl: { type: "string" },
    temperature: { type: "string" },
    json: { type: "boolean" },
    "fail-on": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

function emit(config, human, machine) {
  if (config.json) process.stdout.write(JSON.stringify(machine, null, 2) + "\n");
  else process.stdout.write(human + "\n");
}

function gate(config, results) {
  if (!config.failOn) return;
  const hit = results.filter((r) => (config.failOn === "regressed" ? r.regressed.length > 0 : r.verdict === "worse"));
  if (hit.length) {
    process.stderr.write(`ui-critic: --fail-on ${config.failOn} matched ${hit.length} page(s)\n`);
    process.exitCode = 2;
  }
}

async function doCapture(config, label) {
  if (!config.base) throw new Error("capture needs --base <url> (or base in the config file)");
  if (!label) throw new Error("capture needs --label <name>, for example before or after");
  return capture({ ...config, label });
}

async function doCritique(config, dir) {
  const result = await critique({ dir, config });
  const openRequests = (result.requests ?? []).filter((r) => !(r.kind === "page" && result.followed?.routes?.includes(r.target)));
  emit(
    config,
    [
      `critique written:\n  ${result.jsonPath}\n  ${result.mdPath}`,
      `score ${result.overall.score}/100, revamp needed: ${result.overall.revamp_needed}`,
      `verdict: ${result.overall.verdict}`,
      openRequests.length ? `the critic asks for ${openRequests.length} more thing(s); see the report` : "the critic asked for nothing more",
      usageLine(result.usage),
    ].join("\n"),
    {
      command: "critique",
      dir,
      score: result.overall.score,
      revampNeeded: result.overall.revamp_needed,
      topPriorities: result.overall.top_priorities,
      pages: result.pages.map((p) => ({ route: p.route, score: p.score, findings: p.findings.length })),
      requests: openRequests,
      followed: result.followed,
      usage: result.usage,
      files: { json: result.jsonPath, md: result.mdPath },
    },
  );
  return result;
}

async function doCompare(config, before, after) {
  const result = await compare({ before, after, config });
  emit(
    config,
    [
      `comparison written:\n  ${result.jsonPath}\n  ${result.mdPath}`,
      ...result.results.map((r) => `  ${r.viewport.padEnd(8)} ${r.route.padEnd(44)} ${r.verdict}`),
      usageLine(result.usage),
    ].join("\n"),
    {
      command: "compare",
      before,
      after,
      results: result.results.map((r) => ({ route: r.route, viewport: r.viewport, verdict: r.verdict, regressed: r.regressed.length, improved: r.improved.length })),
      usage: result.usage,
      files: { json: result.jsonPath, md: result.mdPath },
    },
  );
  gate(config, result.results);
  return result;
}

async function main() {
  if (!cmd || flags.help) {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === "init") {
    const written = await init({ base: flags.base });
    process.stdout.write(written.length ? `wrote:\n  ${written.join("\n  ")}\nFill in the brief (Product and Audience at least) before running a critique.\n` : "nothing to do: config and brief already exist\n");
    return;
  }
  const config = await loadConfig(flags);
  switch (cmd) {
    case "cost": {
      const ledger = path.join(config.out, config.ledger);
      const report = await costReport(ledger, config.pricing);
      if (config.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      else process.stdout.write(renderCostReport(report) + "\n");
      break;
    }
    case "models": {
      const models = await listModels(flags.filter);
      const priced = models.map((m) => {
        const price = resolvePrice(m.name, config.pricing);
        return { ...m, price: price ? describePrice(price) : null };
      });
      if (config.json) process.stdout.write(JSON.stringify(priced, null, 2) + "\n");
      else {
        for (const m of priced) process.stdout.write(`${m.name.padEnd(44)} ${m.displayName.padEnd(36)} ${m.price ?? "no price known"}\n`);
        process.stdout.write(`\nBuilt-in prices as of ${PRICING_AS_OF} from ${PRICING_SOURCE}; override under "pricing" in the config.\n`);
      }
      return;
    }
    case "capture": {
      const manifest = await doCapture(config, config.label);
      emit(config, `captured ${manifest.shots.length} screenshots into ${manifest.dir}`, { command: "capture", dir: manifest.dir, shots: manifest.shots.length });
      return;
    }
    case "critique": {
      if (!flags.in) throw new Error("critique needs --in <capture dir>");
      await doCritique(config, flags.in);
      return;
    }
    case "compare": {
      if (!flags.before || !flags.after) throw new Error("compare needs --before <dir> --after <dir>");
      await doCompare(config, flags.before, flags.after);
      return;
    }
    case "run": {
      const manifest = await doCapture(config, config.label);
      process.stderr.write(`captured ${manifest.shots.length} screenshots into ${manifest.dir}\n`);
      await doCritique(config, manifest.dir);
      return;
    }
    case "verify": {
      if (!flags.before) throw new Error("verify needs --before <capture dir> and --base <url>");
      const manifest = await doCapture(config, config.label ?? "after");
      process.stderr.write(`captured ${manifest.shots.length} screenshots into ${manifest.dir}\n`);
      await doCompare(config, flags.before, manifest.dir);
      return;
    }
    default:
      process.stdout.write(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`ui-critic: ${err.message}`);
  process.exitCode = 1;
});
