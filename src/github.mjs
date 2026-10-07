import { readFile } from "node:fs/promises";
import { MARKER } from "./summary.mjs";

/**
 * One pull request comment per run of the tool on a pull request, updated in place
 * on every later run (found by its marker) so a busy pull request does not fill up
 * with reports. Uses the REST API with the token the workflow provides; the token is
 * sent as a header and never printed.
 */

/** The pull request number from a GitHub Actions event payload, or null. */
export async function pullRequestNumber(eventPath) {
  if (!eventPath) return null;
  try {
    const event = JSON.parse(await readFile(eventPath, "utf8"));
    return event.pull_request?.number ?? event.issue?.number ?? event.number ?? null;
  } catch {
    return null;
  }
}

/** Creates the tool's comment on an issue or pull request, or updates the one already there. */
export async function upsertComment({ token, repository, issue, body, api = "https://api.github.com", fetchImpl = fetch }) {
  if (!token) throw new Error("no GitHub token: set GITHUB_TOKEN (the workflow's github.token works, with pull-requests: write)");
  if (!repository || !issue) throw new Error("no pull request to comment on: run this on a pull_request event or pass --pr <number>");
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "content-type": "application/json",
    "user-agent": "ui-critic",
  };
  for (let page = 1; page <= 10; page += 1) {
    const res = await fetchImpl(`${api}/repos/${repository}/issues/${issue}/comments?per_page=100&page=${page}`, { headers });
    if (!res.ok) throw new Error(`listing the pull request's comments failed: HTTP ${res.status}`);
    const list = await res.json();
    const mine = list.find((c) => typeof c.body === "string" && c.body.includes(MARKER));
    if (mine) {
      const update = await fetchImpl(`${api}/repos/${repository}/issues/comments/${mine.id}`, { method: "PATCH", headers, body: JSON.stringify({ body }) });
      if (!update.ok) throw new Error(`updating the comment failed: HTTP ${update.status}`);
      return { action: "updated", id: mine.id };
    }
    if (list.length < 100) break;
  }
  const created = await fetchImpl(`${api}/repos/${repository}/issues/${issue}/comments`, { method: "POST", headers, body: JSON.stringify({ body }) });
  if (!created.ok) throw new Error(`posting the comment failed: HTTP ${created.status}`);
  return { action: "created", id: (await created.json()).id };
}
