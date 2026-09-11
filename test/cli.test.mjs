import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "ui-critic.mjs");
const run = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });

test("--help, -h and no arguments print the help and exit 0", () => {
  for (const args of [["--help"], ["-h"], []]) {
    const r = run(...args);
    assert.equal(r.status, 0, JSON.stringify(args));
    assert.match(r.stdout, /Commands/);
    assert.equal(r.stderr, "");
  }
});

test("an unknown command exits 1 and an unknown flag exits 2, both without a stack trace", () => {
  const cmd = run("bogus");
  assert.equal(cmd.status, 1);
  assert.match(cmd.stdout, /Commands/);
  const flag = run("cost", "--bogus");
  assert.equal(flag.status, 2);
  assert.match(flag.stderr, /^ui-critic: Unknown option/);
  assert.doesNotMatch(flag.stderr, /\n\s+at /);
  assert.match(flag.stdout, /Commands/);
});
