import { test } from "node:test";
import assert from "node:assert/strict";
import { pendingPairs } from "../src/compare.mjs";

test("pendingPairs skips pairs without a before shot and pairs already compared", () => {
  const after = [
    { route: "/", viewport: "desktop" },
    { route: "/", viewport: "mobile" },
    { route: "/new", viewport: "desktop" },
  ];
  const before = [
    { route: "/", viewport: "desktop" },
    { route: "/", viewport: "mobile" },
  ];
  const done = [{ route: "/", viewport: "desktop", verdict: "better" }];
  const pairs = pendingPairs(after, before, done);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].a.viewport, "mobile");
  assert.equal(pendingPairs(after, before).length, 2);
});
