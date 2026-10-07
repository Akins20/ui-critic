import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { benchmarkLabel, renderBenchmarkHTML } from "../src/benchmark.mjs";
import { DEFAULTS, merge, validate } from "../src/config.mjs";
import { blockedReason } from "../src/capture.mjs";

test("a bot check is recognised by its title or its human-verification wording, and only by those", () => {
  assert.match(blockedReason("Just a moment...", ""), /bot check \("Just a moment\.\.\."\)/);
  assert.match(blockedReason("Attention Required! | Cloudflare", ""), /bot check/);
  assert.match(blockedReason("Jumia", "Verifying you are human. This may take a few seconds."), /human-verification page/);
  assert.equal(blockedReason("Sign in | Shop", "This site is protected by reCAPTCHA and the Google Privacy Policy applies."), null, "a page that uses reCAPTCHA is not a challenge page");
  assert.equal(blockedReason("Access to finance made simple", ""), null, "a title that merely starts with Access is not Access denied");
  assert.equal(blockedReason("Home", "Welcome"), null);
});

test("benchmarks are validated: a name, an http base and a route map", () => {
  const ok = { name: "Jumia", base: "https://www.jumia.com.ng", routes: { "/": "/", "/shop": "/catalog/" } };
  assert.doesNotThrow(() => validate(merge(DEFAULTS, { benchmarks: [ok] })));
  assert.throws(() => validate(merge(DEFAULTS, { benchmarks: [{ ...ok, name: "" }] })), /needs a name/);
  assert.throws(() => validate(merge(DEFAULTS, { benchmarks: [{ ...ok, base: "jumia.com" }] })), /http\(s\) URL/);
  assert.throws(() => validate(merge(DEFAULTS, { benchmarks: [{ ...ok, routes: ["/"] }] })), /must map your routes/);
  assert.throws(() => validate(merge(DEFAULTS, { benchmarks: { name: "x" } })), /must be a list/);
  assert.equal(benchmarkLabel("Jumia NG!"), "benchmark-jumia-ng");
});

test("the benchmark report sets ours beside theirs and escapes the critic's text", () => {
  const dir = path.resolve("out", "before");
  const html = renderBenchmarkHTML(
    {
      label: "before",
      base: "https://ours",
      generatedAt: "t",
      benchmarks: [
        {
          name: "Rival <b>",
          base: "https://rival",
          pages: [
            {
              route: "/",
              theirRoute: "/home",
              viewport: "desktop",
              ours: path.join(dir, "home.desktop.fold.png"),
              theirs: path.resolve("out", "benchmark-rival", "home.desktop.fold.png"),
              judgement: { standing: "behind", summary: "They lead.", they_do_better: [{ what: "Price <script>", evidence: "hero", adopt: "Show the monthly price first" }], we_do_better: ["Clearer trust line"], avoid: ["Pop-up on load"] },
            },
          ],
        },
        { name: "Broken", base: "https://x", error: "none of the mapped routes is in the capture" },
      ],
    },
    dir,
  );
  assert.ok(!html.includes("<script>") || html.indexOf("<script>") === html.lastIndexOf("<script>"), "only the page's own theme script");
  assert.match(html, /Price &lt;script&gt;/);
  assert.match(html, /Rival &lt;b&gt;/);
  assert.match(html, /class="standing s-behind">behind/);
  assert.match(html, /Adopt: Show the monthly price first/);
  assert.match(html, /src="home\.desktop\.fold\.png"/);
  assert.match(html, /src="\.\.\/benchmark-rival\/home\.desktop\.fold\.png"/);
  assert.match(html, /none of the mapped routes is in the capture/);
});
