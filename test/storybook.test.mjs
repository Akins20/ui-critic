import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchStories, parseIndex, storyRoutes, storyIdOf, storyLabel } from "../src/storybook.mjs";
import { DEFAULTS, merge, validate } from "../src/config.mjs";

/**
 * The Storybook index is read the way a browser would read it, so both the current
 * `index.json` and the older `stories.json` are covered, along with what is chosen
 * out of a large index and what a story's route looks like.
 */

const V7 = {
  v: 5,
  entries: {
    "button--primary": { id: "button--primary", title: "Forms/Button", name: "Primary", type: "story" },
    "button--secondary": { id: "button--secondary", title: "Forms/Button", name: "Secondary", type: "story" },
    "button--docs": { id: "button--docs", title: "Forms/Button", name: "Docs", type: "docs" },
    "card--default": { id: "card--default", title: "Layout/Card", name: "Default", type: "story" },
    "legacy-modal--default": { id: "legacy-modal--default", title: "Deprecated/Modal", name: "Default", type: "story" },
  },
};

const V6 = {
  v: 3,
  stories: {
    "button--primary": { id: "button--primary", kind: "Forms/Button", story: "Primary" },
    "card--default": { id: "card--default", kind: "Layout/Card", story: "Default" },
  },
};

const serve = (bodies) => async (url) => {
  const name = String(url).split("/").pop();
  if (!(name in bodies)) return { ok: false, status: 404, json: async () => ({}) };
  const body = bodies[name];
  if (body === "broken") return { ok: true, status: 200, json: async () => { throw new Error("not json"); } };
  return { ok: true, status: 200, json: async () => body };
};

test("the index is read from index.json, or stories.json on an older Storybook", async () => {
  const current = await fetchStories("http://localhost:6006", { fetch: serve({ "index.json": V7 }) });
  assert.equal(current.url, "http://localhost:6006/index.json");
  assert.deepEqual(current.stories.map((s) => s.id), ["legacy-modal--default", "button--primary", "button--secondary", "card--default"], "sorted by title then name");

  const old = await fetchStories("http://localhost:6006/", { fetch: serve({ "stories.json": V6 }) });
  assert.deepEqual(old.stories.map((s) => s.id), ["button--primary", "card--default"]);
  assert.equal(old.stories[0].title, "Forms/Button", "the old index calls the title kind");

  // A Storybook that answers with HTML for an unknown path must not look like an index.
  await assert.rejects(() => fetchStories("http://localhost:6006", { fetch: serve({ "index.json": "broken" }) }), /no Storybook index/);
  await assert.rejects(() => fetchStories("http://localhost:6006", { fetch: serve({}) }), /check the URL, and that the Storybook is running/);
  await assert.rejects(() => fetchStories("http://localhost:6006", { fetch: async () => { throw new Error("ECONNREFUSED"); } }), /no Storybook index/);
});

test("docs pages are not components", () => {
  assert.ok(!parseIndex(V7.entries).some((s) => s.id === "button--docs"));
  assert.equal(parseIndex({ x: null, y: { title: "t" } }).length, 0, "an entry with no id is skipped");
});

test("one story per component by default, every one on request, and text picks or drops folders", () => {
  const stories = parseIndex(V7.entries);

  const byDefault = storyRoutes(stories);
  assert.deepEqual(byDefault.stories.map((s) => s.id), ["legacy-modal--default", "button--primary", "card--default"], "the first story of each component");

  assert.equal(storyRoutes(stories, { all: true }).stories.length, 4, "all takes every story");

  const picked = storyRoutes(stories, { include: ["Button"] });
  assert.deepEqual(picked.stories.map((s) => s.id), ["button--primary", "button--secondary"], "naming a component takes all of its stories");

  const dropped = storyRoutes(stories, { all: true, exclude: ["Deprecated"] });
  assert.ok(!dropped.stories.some((s) => s.title.startsWith("Deprecated")));

  const capped = storyRoutes(stories, { all: true, limit: 2 });
  assert.equal(capped.routes.length, 2);
  assert.ok(capped.routes.every((r) => r.path && r.label), "every route carries its name");
  assert.equal(capped.dropped, 2, "what the cap left out is counted, never silently dropped");
});

test("a story becomes a route that renders it alone, and can be named again from the route", () => {
  const { routes } = storyRoutes(parseIndex(V7.entries), { include: ["button--primary"] });
  assert.deepEqual(routes, [{ path: "/iframe.html?id=button--primary&viewMode=story", label: "Forms/Button/Primary" }], "iframe.html renders the component alone, under the story's own name");
  assert.equal(storyIdOf(routes[0].path), "button--primary");
  assert.equal(storyIdOf("/about"), null);
  assert.equal(storyLabel(routes[0].path, parseIndex(V7.entries)), "Forms/Button/Primary");
  assert.equal(storyLabel("/iframe.html?id=unknown--x&viewMode=story", []), "unknown--x", "an id the index does not have still names itself");
});

test("the config takes a Storybook and checks it", () => {
  assert.doesNotThrow(() => validate(merge(DEFAULTS, { storybook: { url: "http://localhost:6006", include: ["Button"], limit: 10 } })));
  assert.throws(() => validate(merge(DEFAULTS, { storybook: { url: "localhost:6006" } })), /storybook.url must be an http/);
  assert.throws(() => validate(merge(DEFAULTS, { storybook: { url: "http://x", include: "Button" } })), /storybook.include must be a list/);
  assert.throws(() => validate(merge(DEFAULTS, { storybook: { url: "http://x", limit: 0 } })), /storybook.limit/);
});
