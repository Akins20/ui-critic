import { readFile } from "node:fs/promises";
import path from "node:path";

/** Sections the critic cannot judge without. */
export const REQUIRED_SECTIONS = ["Product", "Audience"];

/** Phrases that survive only when the template was never filled in. */
const TEMPLATE_MARKERS = ["<Product name>", "What it is, in two sentences", "Who they are, what devices"];

/**
 * Checks that a brief exists and answers the two questions no critique can do
 * without: what the product is for, and who it is for. Returns a list of problems;
 * an empty list means the brief is usable.
 */
export function briefProblems(text) {
  const problems = [];
  const body = (text ?? "").trim();
  if (!body) {
    problems.push("the brief is empty");
    return problems;
  }
  for (const section of REQUIRED_SECTIONS) {
    const re = new RegExp(`^#{1,3}\\s*${section}\\b`, "im");
    const m = body.match(re);
    if (!m) {
      problems.push(`the brief has no "## ${section}" section`);
      continue;
    }
    const after = body.slice(m.index + m[0].length);
    const content = after.split(/^#{1,3}\s/m)[0].trim();
    if (content.length < 40) problems.push(`the "## ${section}" section is too short to judge from`);
  }
  for (const marker of TEMPLATE_MARKERS) {
    if (body.includes(marker)) problems.push(`the brief still contains the template text "${marker}"`);
  }
  return problems;
}

/** Throws a clear, actionable error when the brief would not support a critique. */
export function requireBrief(config) {
  const problems = briefProblems(config.briefText);
  if (!problems.length) return;
  const where = config.brief ? `brief file ${config.brief}` : "no brief configured (set \"brief\" in ui-critic.config.json or pass --brief)";
  throw new Error(
    `a critique needs a brief that says what the product is for and who it is for: ${problems.join("; ")} (${where}). Run \`ui-critic init\` for the template and fill in at least Product and Audience.`,
  );
}

/**
 * Reads the optional extra context: files listed in config.context.files (design
 * tokens, copy decks, policies) and the answers file where the critic's earlier
 * requests were answered. Each file is truncated so one large file cannot crowd out
 * the screenshots.
 */
export async function contextSections(config, limitPerFile = 6000) {
  const sections = [];
  for (const file of config.context?.files ?? []) {
    try {
      const raw = await readFile(path.resolve(file), "utf8");
      const body = raw.length > limitPerFile ? raw.slice(0, limitPerFile) + "\n[truncated]" : raw;
      sections.push(`### Context file: ${file}\n${body}`);
    } catch (err) {
      sections.push(`### Context file: ${file}\n(could not be read: ${err.message})`);
    }
  }
  const answersPath = config.context?.answers;
  if (answersPath) {
    try {
      const raw = await readFile(path.resolve(answersPath), "utf8");
      if (raw.trim()) sections.push(`### Answers to your earlier requests\n${raw.trim().slice(0, limitPerFile)}`);
    } catch {
      // no answers yet; that is the normal first-run state
    }
  }
  return sections.length ? `## Additional context\n${sections.join("\n\n")}` : "";
}
