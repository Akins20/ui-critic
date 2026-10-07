#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadConfig, init } from "../src/config.mjs";
import { capture } from "../src/capture.mjs";
import { critique } from "../src/critique.mjs";
import { compare } from "../src/compare.mjs";
import path from "node:path";
import { usageLine } from "../src/report.mjs";
import { costReport, renderCostReport } from "../src/cost.mjs";
import { gateHits } from "../src/compare.mjs";
import { listModels } from "../src/provider.mjs";
import { resolvePrice, describePrice, PRICING_AS_OF, PRICING_SOURCE } from "../src/pricing.mjs";
import { captureAndroid } from "../src/native/android.mjs";
import { captureIOS, parseSimulators } from "../src/native/ios.mjs";
import { captureFromImages } from "../src/images.mjs";
import { createRunner, findAdb, parseDevices, pickDevice, androidDevice, deviceInfo } from "../src/native/adb.mjs";
import { parseHierarchy, foregroundPackage } from "../src/native/hierarchy.mjs";
import { inspectScreen, renderInspect } from "../src/native/inspect.mjs";
import { parseActivity } from "../src/native/android.mjs";
import { rerender } from "../src/html.mjs";
import { renderCritique } from "../src/report.mjs";
import { compareSummary, critiqueSummary, annotations } from "../src/summary.mjs";
import { upsertComment, pullRequestNumber } from "../src/github.mjs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { lintCapture, renderLint } from "../src/lint.mjs";
import { tryon } from "../src/tryon.mjs";
import { benchmark } from "../src/benchmark.mjs";
import { renderAssets } from "../src/assets.mjs";
import { fidelity } from "../src/figma.mjs";

/** The short summary of the results saved in a capture folder: the comparison if there is one, else the critique. */
async function summaryOf(dir, opts) {
  const read = async (name) => JSON.parse(await readFile(path.join(dir, name), "utf8"));
  try {
    return compareSummary(await read("compare.json"), opts);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  try {
    return critiqueSummary(await read("critique.json"), opts);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  throw new Error(`${dir} has no compare.json or critique.json to summarise`);
}

/**
 * Inside GitHub Actions: the summary goes to the job's summary page and confirmed
 * regressions become annotations, with no extra step in the workflow.
 */
async function reportToActions(config, summary, result) {
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + "\n").catch(() => {});
  if (process.env.GITHUB_ACTIONS === "true" && !config.json && result) for (const line of annotations(result)) process.stdout.write(line + "\n");
}

const HELP = `ui-critic: a second pair of eyes on a UI, for coding agents and humans.

Commands
  init       [--base <url>] [--platform android --package <id>]   write a starter config, brief and decisions file
  models     [--filter flash]                        list the provider's vision models, with prices
  capture    --base <url> --label <name>             screenshot and measure every route at every viewport
  critique   --in <capture dir>                      ranked findings, scores, priorities, the critic's requests
  compare    --before <dir> --after <dir>            what improved, regressed, is still open
  run        --base <url> --label <name>             capture then critique, in one go
  verify     --before <dir> --base <url> [--label after]   capture "after" then compare
  cost       [--out <dir>]                           total the usage ledger per run at today's prices
  tryon      --in <capture dir> --css <file>         lay CSS over the live pages, capture and compare with the original
             --in <capture dir> --goal <text> [--variants 3]   let the critic draft directions as CSS and try each on
             [--routes /,/shop] [--no-judge]          (no-judge renders without asking the critic for verdicts)
  benchmark  --in <capture dir> [--name Jumia]       capture the competitors in "benchmarks" and compare page by page
  assets     --in <capture dir> [--kind store,social] [--captions auto|file.json] [--product name]
                                                    store screenshots (Play 1080x1920, App Store 1290x2796) and
                                                    social cards (1200x630) rendered from the captures
  fidelity   --in <capture dir> [--file <key|link>]  check the build against its Figma frames: the design's own values
             [--no-judge]                            against the rendered ones, and each frame beside the screen
  lint       --in <capture dir> [--fail-on lint]     design-system lint from the computed styles (free): token drift,
                                                    off-palette colours, spacing off the grid, type, radius and shadow sprawl
  report     --in <capture dir>                      render critique.html and compare.html again from saved results (free)
  summary    --in <capture dir> [--fail-on x]        a short Markdown summary for a pull request or a CI job
  comment    --in <capture dir> [--pr N]             post that summary on the pull request, or update the earlier one
                                                    (GITHUB_TOKEN, GITHUB_REPOSITORY; the number comes from the event)
  trend      [--out dir] [--route /shop]             the score of every recorded run, and how it moved (free)
  stories    --storybook <url>                       list the stories a running Storybook can render
  devices                                            list connected Android devices and booted iOS simulators
  inspect    [--serial <id>]                         list what is on an Android screen now, with selectors

Apps and screenshots
  --platform android --package <application id>     capture an Android app on an emulator or device over adb
  --platform ios --bundle-id <id>                   capture an iOS Simulator app (experimental, macOS only)
  --serial <id> | --udid <id>                       which device or simulator, when more than one is connected
  --from-images <dir>                               build the capture from screenshots you already have
                                                    (name them screen.viewport.png; screen.viewport.2.png is a scroll frame)

The brief (ui-critic/brief.md by default) is required for critique, compare, run and
verify: it tells the critic what the product is for and who it is for.

Options (flags win over env, env over ui-critic.config.json, file over defaults)
  --config <file>  --routes /,/shop  --out <dir>  --brief <file>  --model <id>
  --context <file,file>   extra files for the critic (tokens, copy, policies)
  --answers <file>        answers to the critic's earlier requests (default ui-critic/answers.md)
  --follow-requests [--max-pages N]   capture and review same-origin pages the critic asks for
  --thinking-level off|low|medium|high   --include-thoughts   --no-cache   --ttl <seconds>
  --temperature <0..2>   --json (machine-readable summary on stdout)
  --decisions <file>      settled decisions the critic must not reopen (default ui-critic/decisions.md)
  --concurrency <1..8>    calls in flight at once (default 3)
  --no-confirm            skip the second look that confirms each reported regression
  --no-sweep              skip the hover and keyboard sweep of each page (on by default for desktop viewports)
  --a11y                  add accessibility variants: 320px reflow, 200% zoom, text spacing, forced colours,
                          deuteranopia and dark, beside the configured viewports
  --provider gemini|openai   the critic (default: inferred from the model id, gemini)
  --fail-on measured|regressed|worse   (compare/verify: exit 2 when any page matches;
                          measured = a confirmed regression backed by a measured fact, the CI-safe choice)

Environment: GEMINI_API_KEY or OPENAI_API_KEY (never stored), GEMINI_MODEL, UI_CRITIC_PROVIDER,
UI_CRITIC_THINKING, UI_CRITIC_CACHE=0, UI_CRITIC_OUT, UI_CRITIC_BRIEF, UI_CRITIC_CONCURRENCY,
ANDROID_HOME or ADB (where adb is, when it is not in the usual SDK folder).
`;

const OPTIONS = {
  base: { type: "string" },
  label: { type: "string" },
  routes: { type: "string" },
  out: { type: "string" },
  config: { type: "string" },
  brief: { type: "string" },
  context: { type: "string" },
  answers: { type: "string" },
  decisions: { type: "string" },
  concurrency: { type: "string" },
  "no-confirm": { type: "boolean" },
  provider: { type: "string" },
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
  platform: { type: "string" },
  package: { type: "string" },
  serial: { type: "string" },
  "bundle-id": { type: "string" },
  udid: { type: "string" },
  "from-images": { type: "string" },
  artifact: { type: "string" },
  pr: { type: "string" },
  "no-sweep": { type: "boolean" },
  a11y: { type: "boolean" },
  css: { type: "string" },
  goal: { type: "string" },
  variants: { type: "string" },
  "no-judge": { type: "boolean" },
  name: { type: "string" },
  kind: { type: "string" },
  file: { type: "string" },
  storybook: { type: "string" },
  stories: { type: "string" },
  "all-stories": { type: "boolean" },
  route: { type: "string" },
  captions: { type: "string" },
  product: { type: "string" },
  help: { type: "boolean", short: "h" },
};

const argv = process.argv.slice(2);
// A leading flag (--help, -h) means no command was given.
const [cmd, ...rest] = argv[0]?.startsWith("-") ? [undefined, ...argv] : argv;
let flags;
try {
  ({ values: flags } = parseArgs({ args: rest, allowPositionals: true, options: OPTIONS }));
} catch (err) {
  console.error("ui-critic: " + err.message + "\n");
  process.stdout.write(HELP);
  process.exit(2);
}

function emit(config, human, machine) {
  if (config.json) process.stdout.write(JSON.stringify(machine, null, 2) + "\n");
  else process.stdout.write(human + "\n");
}

function gate(config, results) {
  if (!config.failOn) return;
  const hit = gateHits(results, config.failOn);
  if (hit.length) {
    process.stderr.write(`ui-critic: --fail-on ${config.failOn} matched ${hit.length} page(s)\n`);
    process.exitCode = 2;
  }
}

async function doCapture(config, label) {
  if (!label) throw new Error("capture needs --label <name>, for example before or after");
  if (config.fromImages) return captureFromImages({ from: config.fromImages, out: config.out, label });
  if (config.platform === "android") return captureAndroid({ ...config, label });
  if (config.platform === "ios") return captureIOS({ ...config, label });
  const book = await storybookConfig(config);
  if (!book.base) throw new Error("capture needs --base <url> (or base in the config file)");
  return capture({ ...book, label });
}

/**
 * A Storybook's stories as the routes to capture. The index is read from the running
 * Storybook, so the review follows whatever is in it today rather than a list anyone
 * has to keep up to date.
 */
async function storybookConfig(config) {
  const url = config.storybook?.url;
  if (!url) return config;
  const { fetchStories, storyRoutes } = await import("../src/storybook.mjs");
  const { stories } = await fetchStories(url);
  const picked = storyRoutes(stories, config.storybook);
  if (!picked.routes.length) throw new Error(`the Storybook at ${url} has ${stories.length} stories but none matched; check storybook.include and storybook.exclude`);
  process.stderr.write(`  ${picked.routes.length} of ${stories.length} stories${picked.dropped ? `, ${picked.dropped} over storybook.limit not taken` : ""}\n`);
  return { ...config, base: url, routes: picked.routes, scenarios: [], storybookStories: picked.stories };
}

/** What a capture produced, in words: screenshots of pages, or screens of an app. */
function captured(manifest) {
  const what = manifest.platform && manifest.platform !== "web" ? `${manifest.shots.length} screens` : `${manifest.shots.length} screenshots`;
  return `captured ${what} into ${manifest.dir}`;
}

/** Connected Android devices (when adb is found) and booted iOS simulators (on macOS). */
async function doDevices(config) {
  const run = createRunner({ timeoutMs: 20_000 });
  const out = { android: [], ios: [], notes: [] };
  try {
    const adb = await findAdb({ configured: config.android?.adb });
    out.android = parseDevices((await run(adb, ["devices", "-l"])).toString("utf8"));
  } catch (err) {
    out.notes.push(`Android: ${err.message.includes("ENOENT") ? "adb not found (install Android platform-tools, or set ANDROID_HOME or ADB)" : err.message}`);
  }
  if (process.platform === "darwin") {
    try {
      out.ios = parseSimulators((await run("xcrun", ["simctl", "list", "devices", "booted", "-j"])).toString("utf8"));
    } catch (err) {
      out.notes.push(`iOS: ${err.message}`);
    }
  }
  return out;
}

/** What is on the chosen Android device's screen right now, read-only. */
async function doInspect(config) {
  const run = createRunner();
  const adb = await findAdb({ configured: config.android?.adb });
  const chosen = pickDevice(parseDevices((await run(adb, ["devices", "-l"])).toString("utf8")), config.android?.serial);
  const dev = androidDevice({ adb, serial: chosen.serial, run });
  const [info, xml, focus] = await Promise.all([deviceInfo(dev), dev.dump(), dev.focusedWindow()]);
  const { nodes } = parseHierarchy(xml);
  const activity = parseActivity(focus);
  const rows = inspectScreen(nodes, info);
  const header = `${chosen.serial} (${info.model}, Android ${info.android}, ${info.screen.width}x${info.screen.height} at ${info.density}dpi = ${info.pxPerDp}px per dp): ${activity ?? foregroundPackage(nodes) ?? "unknown screen"}`;
  return { header, rows, activity, device: { serial: chosen.serial, ...info } };
}

async function doCritique(config, dir) {
  const result = await critique({ dir, config });
  const openRequests = (result.requests ?? []).filter((r) => !(r.kind === "page" && result.followed?.routes?.includes(r.target)));
  emit(
    config,
    [
      `critique written:\n  ${result.htmlPath}\n  ${result.mdPath}\n  ${result.jsonPath}`,
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
      files: { json: result.jsonPath, md: result.mdPath, html: result.htmlPath },
    },
  );
  await reportToActions(config, critiqueSummary(result), null);
  return result;
}

async function doCompare(config, before, after) {
  const result = await compare({ before, after, config });
  emit(
    config,
    [
      `comparison written:\n  ${result.htmlPath}\n  ${result.mdPath}\n  ${result.jsonPath}`,
      ...result.results.map((r) => `  ${r.viewport.padEnd(8)} ${r.route.padEnd(44)} ${r.verdict}`),
      usageLine(result.usage),
    ].join("\n"),
    {
      command: "compare",
      before,
      after,
      results: result.results.map((r) => ({ route: r.route, viewport: r.viewport, verdict: r.verdict, regressed: r.regressed.length, improved: r.improved.length })),
      usage: result.usage,
      files: { json: result.jsonPath, md: result.mdPath, html: result.htmlPath },
    },
  );
  await reportToActions(config, compareSummary(result, { failOn: config.failOn }), result);
  gate(config, result.results);
  return result;
}

async function main() {
  if (!cmd || flags.help) {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === "init") {
    const written = await init({ base: flags.base, platform: flags.platform ?? "web", pkg: flags.package ?? flags["bundle-id"] });
    process.stdout.write(written.length ? `wrote:\n  ${written.join("\n  ")}\nFill in the brief (Product and Audience at least) before running a critique.\n` : "nothing to do: config and brief already exist\n");
    return;
  }
  const config = await loadConfig(flags);
  switch (cmd) {
    case "devices": {
      const found = await doDevices(config);
      if (config.json) process.stdout.write(JSON.stringify(found, null, 2) + "\n");
      else {
        const lines = [];
        for (const d of found.android) lines.push(`android  ${d.serial.padEnd(20)} ${d.state.padEnd(12)} ${d.model ?? ""}${d.emulator ? " (emulator)" : ""}`);
        for (const s of found.ios) lines.push(`ios      ${s.udid.padEnd(38)} ${s.name} (${s.runtime})`);
        if (!lines.length) lines.push("no devices or simulators found");
        process.stdout.write([...lines, ...found.notes].join("\n") + "\n");
      }
      return;
    }
    case "tryon": {
      if (!flags.in) throw new Error("tryon needs --in <capture dir>, and --css <file> or --goal <text>");
      const css = flags.css ? await readFile(flags.css, "utf8") : null;
      const routes = flags.routes ? config.routes.map((r) => (typeof r === "string" ? r : r.path)) : null;
      const result = await tryon({ dir: flags.in, config, goal: flags.goal, count: flags.variants ? Number(flags.variants) : 3, css, routes, judge: !flags["no-judge"] });
      const line = (d) =>
        d.changedNothing
          ? `  ${d.name}: changed nothing on the first screens (check the selectors)`
          : `  ${d.name}: ${d.pages.map((p) => `${p.route}@${p.viewport} ${p.percent ?? "?"}% changed${p.judgement ? `, ${p.judgement.verdict}, serves the goal: ${p.judgement.serves_goal}` : ""}`).join("; ")}`;
      emit(
        config,
        [`try-on written:\n  ${result.htmlPath}\n  ${result.jsonPath}`, ...result.directions.map(line), result.pick?.best ? `recommended: ${result.pick.best}. ${result.pick.why}` : ""].filter(Boolean).join("\n"),
        {
          command: "tryon",
          goal: result.goal,
          pick: result.pick,
          directions: result.directions.map((d) => ({ name: d.name, rationale: d.rationale, dir: d.dir, changedNothing: d.changedNothing, pages: d.pages.map((p) => ({ route: p.route, viewport: p.viewport, percent: p.percent, verdict: p.judgement?.verdict ?? null, servesGoal: p.judgement?.serves_goal ?? null })) })),
          files: { html: result.htmlPath, json: result.jsonPath },
        },
      );
      return;
    }
    case "assets": {
      if (!flags.in) throw new Error("assets needs --in <capture dir>");
      const kinds = flags.kind ? flags.kind.split(",").map((k) => k.trim()) : ["store", "social"];
      const auto = flags.captions === "auto";
      const captions = flags.captions && !auto ? JSON.parse(await readFile(flags.captions, "utf8")) : {};
      const result = await renderAssets({ dir: flags.in, config, kinds, captions, auto, product: flags.product });
      emit(config, [`assets written to ${result.dir}:`, ...result.files.map((f) => `  ${path.relative(result.dir, f.file)} (${f.width}x${f.height})`), `background ${result.colors.bg}, captions in ${result.colors.ink}`].join("\n"), { command: "assets", dir: result.dir, colors: result.colors, captions: result.captions, files: result.files });
      return;
    }
    case "trend": {
      const { readTrend, renderTrend } = await import("../src/trend.mjs");
      const { unmangleRoute } = await import("../src/config.mjs");
      const rows = await readTrend(config.out);
      emit(config, renderTrend(rows, { route: flags.route ? unmangleRoute(flags.route) : null }), { command: "trend", runs: rows });
      return;
    }
    case "stories": {
      if (!config.storybook?.url) throw new Error("stories needs --storybook <url> of a running Storybook");
      const { fetchStories, storyRoutes } = await import("../src/storybook.mjs");
      const { url, stories } = await fetchStories(config.storybook.url);
      const picked = storyRoutes(stories, config.storybook);
      const chosen = new Set(picked.stories.map((s) => s.id));
      emit(
        config,
        [`${stories.length} stories in ${url}, ${picked.stories.length} would be captured:`, ...stories.map((s) => `  ${chosen.has(s.id) ? "*" : " "} ${s.title}/${s.name}  ${s.id}`)].join("\n"),
        { command: "stories", index: url, stories, chosen: picked.stories, dropped: picked.dropped },
      );
      return;
    }
    case "fidelity": {
      if (!flags.in) throw new Error("fidelity needs --in <capture dir>");
      const result = await fidelity({ dir: flags.in, config, key: flags.file, judge: !flags["no-judge"] });
      const counts = result.pages.map((p) => `${p.route}@${p.viewport}: ${p.judgement?.standing ?? "measured"}`);
      emit(config, [`fidelity against ${result.fileName ?? result.figmaFile}`, ...counts.map((c) => `  ${c}`), `written to ${result.mdPath} and ${result.htmlPath}`].join("\n"), { command: "fidelity", pages: result.pages.map((p) => ({ route: p.route, viewport: p.viewport, frame: p.frame.name, standing: p.judgement?.standing ?? null, differences: p.judgement?.differences?.length ?? 0 })), unmatchedScreens: result.unmatchedScreens, unusedFrames: result.unusedFrames, htmlPath: result.htmlPath });
      return;
    }
    case "benchmark": {
      if (!flags.in) throw new Error("benchmark needs --in <capture dir> and benchmarks in the config");
      const result = await benchmark({ dir: flags.in, config, only: flags.name, judge: !flags["no-judge"] });
      const lines = result.benchmarks.flatMap((b) => (b.error ? [`  ${b.name}: ${b.error}`] : b.pages.map((p) => `  ${b.name}: ${p.route} vs ${p.theirRoute} at ${p.viewport}: ${p.judgement?.standing ?? (p.error ? `not compared (${p.error.slice(0, 80)})` : "captured")}`)));
      emit(config, [`benchmarks written:\n  ${result.htmlPath}\n  ${result.jsonPath}`, ...lines].join("\n"), {
        command: "benchmark",
        benchmarks: result.benchmarks.map((b) => ({ name: b.name, error: b.error ?? null, pages: (b.pages ?? []).map((p) => ({ route: p.route, theirRoute: p.theirRoute, viewport: p.viewport, standing: p.judgement?.standing ?? null })) })),
        files: { html: result.htmlPath, json: result.jsonPath },
      });
      return;
    }
    case "lint": {
      if (!flags.in) throw new Error("lint needs --in <capture dir>");
      const result = await lintCapture(flags.in, config.lint ?? {});
      const jsonPath = path.join(flags.in, "lint.json");
      const mdPath = path.join(flags.in, "lint.md");
      await writeFile(jsonPath, JSON.stringify(result, null, 2));
      await writeFile(mdPath, renderLint(result));
      const count = (s) => result.findings.filter((f) => f.severity === s).length;
      emit(
        config,
        [`lint written:\n  ${mdPath}\n  ${jsonPath}`, `${result.findings.length} findings (${count("high")} high, ${count("medium")} medium, ${count("low")} low)`, ...result.findings.map((f) => `  [${f.severity}] ${f.title}`)].join("\n"),
        { command: "lint", findings: result.findings.map((f) => ({ rule: f.rule, severity: f.severity, title: f.title })), metrics: result.metrics, files: { json: jsonPath, md: mdPath } },
      );
      if (config.failOn === "lint" && count("high") > 0) {
        process.stderr.write(`ui-critic: --fail-on lint matched ${count("high")} high-severity finding(s)\n`);
        process.exitCode = 2;
      }
      return;
    }
    case "summary": {
      if (!flags.in) throw new Error("summary needs --in <capture dir>");
      process.stdout.write(await summaryOf(flags.in, { failOn: config.failOn, artifact: flags.artifact }));
      return;
    }
    case "comment": {
      if (!flags.in) throw new Error("comment needs --in <capture dir>");
      const body = await summaryOf(flags.in, { failOn: config.failOn, artifact: flags.artifact });
      const issue = flags.pr ? Number(flags.pr) : await pullRequestNumber(process.env.GITHUB_EVENT_PATH);
      const done = await upsertComment({
        token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
        repository: process.env.GITHUB_REPOSITORY,
        issue,
        body,
        api: process.env.GITHUB_API_URL ?? "https://api.github.com",
      });
      emit(config, `pull request #${issue}: comment ${done.action}`, { command: "comment", issue, ...done });
      return;
    }
    case "report": {
      if (!flags.in) throw new Error("report needs --in <capture dir>");
      const written = await rerender(flags.in, { renderCritique });
      emit(config, `written:\n  ${written.join("\n  ")}`, { command: "report", files: written });
      return;
    }
    case "inspect": {
      const result = await doInspect(config);
      if (config.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      else process.stdout.write(renderInspect(result.rows, result.header) + "\n");
      return;
    }
    case "cost": {
      const ledger = path.join(config.out, config.ledger);
      const report = await costReport(ledger, config.pricing);
      if (config.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      else process.stdout.write(renderCostReport(report) + "\n");
      break;
    }
    case "models": {
      const models = await listModels(config, flags.filter);
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
      emit(config, captured(manifest), { command: "capture", platform: manifest.platform ?? "web", dir: manifest.dir, shots: manifest.shots.length });
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
      process.stderr.write(`${captured(manifest)}\n`);
      await doCritique(config, manifest.dir);
      return;
    }
    case "verify": {
      if (!flags.before) throw new Error("verify needs --before <capture dir>, and --base <url> (or --platform, or --from-images) for the after capture");
      const manifest = await doCapture(config, config.label ?? "after");
      process.stderr.write(`${captured(manifest)}\n`);
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
