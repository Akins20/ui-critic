import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stepProblems, readEnvFile, secretFrom, normalizeRoute } from "../src/steps.mjs";
import { routeSlug, scenarioLabel } from "../src/capture.mjs";
import { DEFAULTS, merge, validate } from "../src/config.mjs";

test("stepProblems accepts the vocabulary and rejects malformed steps", () => {
  assert.deepEqual(stepProblems([{ click: "text=Filters" }, { wait: 300 }, { fill: { selector: "input", value: "x" } }, { fill: { selector: "input", envVar: "V" } }, { press: "Tab" }, { scroll: 0 }]), []);
  const problems = stepProblems([{ click: "" }, { fill: { selector: "input" } }, { wait: -1 }, { nope: 1 }, { click: "a", hover: "b" }]);
  assert.equal(problems.length, 5);
});

test("readEnvFile parses KEY=VALUE lines without touching process.env", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ui-critic-env-"));
  const file = path.join(dir, "auth.env");
  await writeFile(file, "# comment\nexport A=1\nB=\"two words\"\nC='x'\nbad line\n");
  const map = await readEnvFile(file);
  assert.deepEqual(map, { A: "1", B: "two words", C: "x" });
  assert.equal(process.env.A, undefined);
  assert.equal(secretFrom("B", map), "two words");
  assert.equal(secretFrom("MISSING", map), null);
  assert.deepEqual(await readEnvFile(path.join(dir, "none")), {});
});

test("routes normalise and scenarios label and slug cleanly", () => {
  assert.deepEqual(normalizeRoute("/x"), { path: "/x", auth: false });
  assert.deepEqual(normalizeRoute({ path: "/account", auth: true }), { path: "/account", auth: true, label: undefined });
  assert.equal(scenarioLabel("/shop", "filters-open"), "/shop [filters-open]");
  assert.equal(scenarioLabel("/shop"), "/shop");
  assert.equal(routeSlug("/shop?q=wig"), "shop-q-q-wig");
});

test("config validates scenarios and refuses literal passwords in auth steps", () => {
  const ok = merge(DEFAULTS, { scenarios: [{ name: "open", route: "/shop", steps: [{ click: "text=Filters" }] }], auth: { mode: "form", steps: [{ fill: { selector: "input[name=password]", envVar: "P" } }] } });
  assert.equal(validate(ok).scenarios.length, 1);
  assert.throws(() => validate(merge(DEFAULTS, { scenarios: [{ name: "x", route: "/", steps: [{ wait: -5 }] }] })), /non-negative/);
  assert.throws(() => validate(merge(DEFAULTS, { auth: { mode: "form", steps: [{ fill: { selector: "input[name=password]", value: "hunter2" } }] } })), /literal password/);
  assert.throws(() => validate(merge(DEFAULTS, { auth: { mode: "cookie" } })), /auth.mode/);
});
