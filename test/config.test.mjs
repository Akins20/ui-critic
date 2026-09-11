import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULTS, merge, envOverrides, flagOverrides, validate, loadConfig, init } from "../src/config.mjs";

test("merge is deep for objects and replaces arrays and scalars", () => {
  const out = merge({ a: { x: 1, y: 2 }, list: [1, 2], s: "a" }, { a: { y: 3 }, list: [9], s: "b", u: undefined });
  assert.deepEqual(out, { a: { x: 1, y: 3 }, list: [9], s: "b" });
});

test("defaults cover every knob", () => {
  assert.equal(DEFAULTS.model, "gemini-3.8-flash");
  assert.equal(DEFAULTS.thinking.level, "high");
  assert.equal(DEFAULTS.cache.enabled, true);
  assert.ok(DEFAULTS.cache.minTokens > 0);
  assert.equal(DEFAULTS.generation.temperature, 0.3);
  assert.equal(DEFAULTS.generation.maxOutputTokens, 32768);
  assert.deepEqual(DEFAULTS.routes, ["/"]);
});

test("precedence is defaults < file < env < flags", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ui-critic-"));
  const configPath = path.join(dir, "ui-critic.config.json");
  await writeFile(configPath, JSON.stringify({ model: "from-file", thinking: { level: "low" }, out: "file-out" }));
  const cfg = await loadConfig(
    { config: configPath, "thinking-level": "medium" },
    { GEMINI_MODEL: "from-env", UI_CRITIC_OUT: "env-out" },
  );
  assert.equal(cfg.model, "from-env");
  assert.equal(cfg.out, "env-out");
  assert.equal(cfg.thinking.level, "medium");
  assert.equal(cfg.thinking.includeThoughts, false);
  assert.equal(cfg.cache.enabled, true);
});

test("env and flag overrides map to the right keys", () => {
  assert.deepEqual(envOverrides({ UI_CRITIC_CACHE: "0", UI_CRITIC_THINKING: "off" }), { thinking: { level: "off" }, cache: { enabled: false } });
  const f = flagOverrides({ routes: "/, /shop ,", "no-cache": true, ttl: "60", temperature: "0.1", "include-thoughts": true, json: true, "fail-on": "worse" });
  assert.deepEqual(f.routes, ["/", "/shop"]);
  assert.deepEqual(f.cache, { enabled: false, ttlSeconds: 60 });
  assert.deepEqual(f.generation, { temperature: 0.1 });
  assert.deepEqual(f.thinking, { includeThoughts: true });
  assert.equal(f.json, true);
  assert.equal(f.failOn, "worse");
});

test("validate rejects bad thinking levels, temperatures and viewports", () => {
  assert.throws(() => validate(merge(DEFAULTS, { thinking: { level: "max" } })), /thinking.level/);
  assert.throws(() => validate(merge(DEFAULTS, { generation: { temperature: 3 } })), /temperature/);
  assert.throws(() => validate(merge(DEFAULTS, { routes: [] })), /routes/);
  assert.throws(() => validate(merge(DEFAULTS, { viewports: { odd: { width: 0, height: 10 } } })), /viewport odd/);
  assert.equal(validate(merge(DEFAULTS, {})).model, DEFAULTS.model);
});

test("init writes a config with every default and a brief, and never overwrites", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ui-critic-init-"));
  const first = await init({ base: "http://localhost:4000", cwd: dir });
  assert.equal(first.length, 3);
  const cfg = JSON.parse(await readFile(path.join(dir, "ui-critic.config.json"), "utf8"));
  assert.equal(cfg.base, "http://localhost:4000");
  assert.equal(cfg.thinking.level, "high");
  assert.equal(cfg.cache.ttlSeconds, 3600);
  assert.deepEqual(cfg.pricing, {});
  const brief = await readFile(path.join(dir, "ui-critic", "brief.md"), "utf8");
  assert.match(brief, /## Brand system/);
  const second = await init({ cwd: dir });
  assert.equal(second.length, 0);
});
