import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseHierarchy,
  parseBounds,
  decodeEntities,
  parseSelector,
  findNode,
  findNodes,
  labelOf,
  tapPoint,
  signature,
  mainScrollable,
  scrollAxis,
  maybeClipped,
  isVisible,
  foregroundPackage,
  overlaysOver,
  coveredByOverlay,
  within,
} from "../src/native/hierarchy.mjs";
import { decodePNG } from "../src/png.mjs";
import { estimateTextContrast } from "../src/pixels.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(path.join(here, "fixtures", "android", name));
// Recorded from the Settings app on an Android 16 emulator (1080x2400, density 420).
const home = parseHierarchy(fixture("settings-home.xml").toString("utf8"));
const scrolled = parseHierarchy(fixture("settings-scrolled.xml").toString("utf8"));

test("a real uiautomator dump parses into a linked node tree", () => {
  assert.equal(home.rotation, 0);
  assert.equal(home.nodes.length, 75);
  const root = home.nodes[0];
  assert.equal(root.parent, -1);
  assert.equal(root.pkg, "com.android.settings");
  assert.deepEqual(root.bounds, { x1: 0, y1: 0, x2: 1080, y2: 2400, width: 1080, height: 2400 });
  for (const n of home.nodes.slice(1)) assert.ok(home.nodes[n.parent].children.includes(n.index));
  assert.equal(foregroundPackage(home.nodes), "com.android.settings");
});

test("entities are decoded, including numeric ones", () => {
  assert.equal(decodeEntities("Sound &amp; vibration &lt;b&gt; &quot;x&quot; &#39;y&#39; &#x2011;"), `Sound & vibration <b> "x" 'y' ‑`);
  assert.ok(findNode(home.nodes, "text=Network & internet"));
  assert.equal(parseBounds("[0,315][1080,563]").height, 248);
  assert.equal(parseBounds("nonsense"), null);
});

test("a tokenizer keeps quotes and angle brackets inside attribute values", () => {
  const xml = `<?xml version='1.0' ?><hierarchy rotation="1"><node text="a > b" content-desc='say "hi"' class="x.Y" bounds="[0,0][10,10]"><node text="child" bounds="[1,1][5,5]" /></node></hierarchy>`;
  const { rotation, nodes } = parseHierarchy(xml);
  assert.equal(rotation, 1);
  assert.equal(nodes[0].text, "a > b");
  assert.equal(nodes[0].desc, 'say "hi"');
  assert.equal(nodes[1].parent, 0);
  assert.equal(parseHierarchy("").nodes.length, 0);
});

test("selectors: exact first, then case-insensitive substring; quoted means exact; nth picks among matches", () => {
  assert.deepEqual(parseSelector("text='Save' >> nth=2"), { by: "text", value: "Save", nth: 2, exact: true });
  assert.deepEqual(parseSelector("Apps"), { by: "any", value: "Apps", nth: 0, exact: false });
  assert.equal(findNode(home.nodes, "text=Apps").text, "Apps");
  assert.equal(findNode(home.nodes, "text=network").text, "Network & internet");
  assert.equal(findNode(home.nodes, "text='network'"), null);
  assert.equal(findNode(home.nodes, "id=search_action_bar").clickable, true);
  assert.equal(findNodes(home.nodes, "class=TextView").length > 10, true);
  assert.equal(findNode(home.nodes, "class=TextView >> nth=1").text, "Google");
  // A fully scrolled-away node never matches: its bounds are empty.
  assert.equal(findNode(home.nodes, "text=Storage"), null);
});

test("a row's label comes from its children, as a screen reader announces it", () => {
  const title = findNode(home.nodes, "text=Network & internet");
  const row = home.nodes.find((n) => n.clickable && n.children.length && labelOf(home.nodes, n).startsWith("Network"));
  assert.equal(labelOf(home.nodes, row), "Network & internet Mobile, Wi‑Fi, hotspot");
  assert.equal(row.text, "");
  assert.deepEqual(tapPoint(title), { x: 428, y: 641 });
});

test("the fingerprint changes when the screen scrolls and not otherwise", () => {
  assert.equal(signature(home.nodes), signature(parseHierarchy(fixture("settings-home.xml").toString("utf8")).nodes));
  assert.notEqual(signature(home.nodes), signature(scrolled.nodes));
});

test("the main scrollable is found and its axis read from its children", () => {
  const list = mainScrollable(home.nodes);
  assert.match(list.id, /recycler_view$/);
  assert.equal(scrollAxis(home.nodes, list), "y");
  const carousel = parseHierarchy(
    `<hierarchy><node class="androidx.recyclerview.widget.RecyclerView" scrollable="true" bounds="[0,100][1080,400]"><node class="v" bounds="[0,100][500,400]"/><node class="v" bounds="[520,100][1020,400]"/><node class="v" bounds="[1040,100][1080,400]"/></node></hierarchy>`,
  ).nodes;
  assert.equal(scrollAxis(carousel, carousel[0]), "x");
  // The card cut off at the right edge is clipped; the first one is not.
  assert.equal(maybeClipped(carousel, carousel[3], { width: 1080, height: 2400 }), true);
  assert.equal(maybeClipped(carousel, carousel[1], { width: 1080, height: 2400 }), false);
});

test("a row cut off at the bottom of the list is clipped; a full row is not", () => {
  const screen = { width: 1080, height: 2400 };
  const rows = home.nodes.filter((n) => n.clickable && isVisible(n) && n.bounds.x1 === 0 && n.bounds.width === 1080);
  const last = rows[rows.length - 1];
  assert.equal(last.bounds.height, 42, "the recorded dump has a 42px sliver at the bottom");
  assert.equal(maybeClipped(home.nodes, last, screen), true);
  const first = rows.find((r) => labelOf(home.nodes, r).startsWith("Network"));
  assert.equal(maybeClipped(home.nodes, first, screen), false);
  // After scrolling, a row touching the top of the list may be cut off as well.
  const top = rows[0];
  assert.equal(maybeClipped(home.nodes, top, screen, { leading: true }), true);
});

test("text scrolled under a floating bar is covered, whatever the document order says", () => {
  // Shaped like a React Native app with an SVG tab bar: the bar's shape comes before
  // the list in document order, a tab item after it; both float over the list.
  const xml = `<hierarchy>
    <node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">
      <node class="com.horcrux.svg.SvgView" bounds="[0,2096][1080,2384]" />
      <node class="android.view.ViewGroup" bounds="[0,0][1080,2400]">
        <node class="android.widget.ScrollView" scrollable="true" bounds="[0,189][1080,2400]">
          <node class="android.widget.TextView" text="Visible title" bounds="[42,1500][500,1542]" />
          <node class="android.widget.TextView" text="Under the bar" bounds="[42,2200][500,2242]" />
        </node>
      </node>
      <node class="android.view.View" content-desc="Shop" clickable="true" bounds="[58,2175][242,2307]" />
      <node class="android.view.ViewGroup" bounds="[0,0][1080,2400]" />
    </node>
  </hierarchy>`;
  const { nodes } = parseHierarchy(xml);
  const screen = { width: 1080, height: 2400 };
  const list = mainScrollable(nodes);
  const overlays = overlaysOver(nodes, list, screen).map((n) => n.cls.split(".").pop());
  assert.deepEqual(overlays, ["SvgView", "View"], "the bar and its tab, not the full-screen wrappers");
  assert.equal(coveredByOverlay(nodes, findNode(nodes, "text=Under the bar"), screen), true);
  assert.equal(coveredByOverlay(nodes, findNode(nodes, "text=Visible title"), screen), false);
  assert.equal(within(nodes, findNode(nodes, "text=Visible title"), list), true);
});

test("contrast measured from the real screenshot matches the Material 3 tokens", () => {
  const img = decodePNG(fixture("settings-home.png"));
  const measure = (selector) => {
    const b = findNode(home.nodes, selector).bounds;
    return estimateTextContrast(img, { x: b.x1, y: b.y1, width: b.width, height: b.height });
  };
  const title = measure("text=Apps");
  assert.equal(title.fg, "#1a1b21");
  assert.equal(title.bg, "#faf8ff");
  assert.ok(title.ratio > 16 && title.ratio < 16.6, `title ${title.ratio}`);
  const summary = measure("text=Bluetooth, pairing");
  assert.equal(summary.fg, "#45464f");
  assert.ok(summary.ratio > 8.7 && summary.ratio < 9.1, `summary ${summary.ratio}`);
});
