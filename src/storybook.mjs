/**
 * Storybook: review the components, not only the pages. A Storybook already lists
 * every story it can render, so the stories become routes and the rest of the tool
 * (capture, measured facts, the lint, the sweep, the critic, compare) works on them
 * unchanged. A story renders alone at /iframe.html, without the Storybook chrome, so
 * what is judged is the component and nothing else.
 *
 * Both index formats are read: `index.json` (Storybook 7 and later) and the older
 * `stories.json`. Nothing is written to the Storybook; it is read like any page.
 */

/** The story index of a running Storybook, trying the current name then the old one. */
export async function fetchStories(base, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const tried = [];
  for (const name of ["index.json", "stories.json"]) {
    const url = new URL(name, base.endsWith("/") ? base : `${base}/`).toString();
    tried.push(url);
    let res;
    try {
      res = await fetchImpl(url);
    } catch (err) {
      continue;
    }
    if (!res.ok) continue;
    let body;
    try {
      body = await res.json();
    } catch {
      continue;
    }
    const entries = body.entries ?? body.stories;
    if (entries && typeof entries === "object") return { url, stories: parseIndex(entries) };
  }
  throw new Error(`no Storybook index at ${tried.join(" or ")}: check the URL, and that the Storybook is running or the static build is being served`);
}

/** The index's entries as a plain list, docs pages left out: they are prose, not components. */
export function parseIndex(entries) {
  return Object.values(entries)
    .filter((e) => e && e.id && (e.type ?? "story") === "story")
    .map((e) => ({ id: e.id, title: e.title ?? e.kind ?? "", name: e.name ?? e.story ?? "" }))
    .sort((a, b) => `${a.title}/${a.name}`.localeCompare(`${b.title}/${b.name}`));
}

const matches = (story, pattern) => {
  const text = `${story.title}/${story.name}`.toLowerCase();
  return text.includes(pattern.toLowerCase()) || story.id.toLowerCase().includes(pattern.toLowerCase());
};

/**
 * The stories to review as routes. `include` and `exclude` are plain text matched
 * against "Title/Name" and the id, so "Button" takes every button story and
 * "Deprecated" drops a folder. Without `include`, one story per component is taken
 * (the first, usually the default), because a hundred variants of a button is a
 * large bill for little more than the first one tells you; `all` takes every one.
 */
export function storyRoutes(stories, { include = [], exclude = [], all = false, limit = 40 } = {}) {
  let chosen = stories;
  if (include.length) chosen = chosen.filter((s) => include.some((p) => matches(s, p)));
  if (exclude.length) chosen = chosen.filter((s) => !exclude.some((p) => matches(s, p)));
  if (!all && !include.length) {
    const seen = new Set();
    chosen = chosen.filter((s) => !seen.has(s.title) && seen.add(s.title));
  }
  const dropped = Math.max(0, chosen.length - limit);
  const taken = chosen.slice(0, limit);
  // The route carries the story's name, so reports and screenshot files say
  // "Forms/Button/Primary" rather than the iframe URL that renders it.
  return {
    routes: taken.map((s) => ({ path: `/iframe.html?id=${encodeURIComponent(s.id)}&viewMode=story`, label: `${s.title}/${s.name}`.replace(/^\/+/, "") })),
    stories: taken,
    dropped,
  };
}

/** The story id back out of a route, for naming a story in a report. */
export function storyIdOf(route) {
  const match = String(route).match(/[?&]id=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/** A readable label for a story route, "Title / Name" where the index knows it. */
export function storyLabel(route, stories) {
  const id = storyIdOf(route);
  if (!id) return route;
  const story = stories.find((s) => s.id === id);
  return story ? `${story.title}/${story.name}` : id;
}
