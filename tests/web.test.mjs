import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { epubToText } from "../docs/epub.js";
import { Chain } from "../docs/markov.js";

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "bad-fanfic-"));

function fixture(name, chapters = 3, drm = false) {
  const out = join(dir, name);
  const args = [join(here, "epub_fixture.py"), out, String(chapters)];
  if (drm) args.push("drm");
  const r = spawnSync("python3", args, { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const b = readFileSync(out);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

test("epub: keeps chapters, drops front matter, normalizes punctuation", async () => {
  const text = await epubToText(fixture("a.epub"));
  assert.match(text, /Chapter 1/);
  assert.match(text, /Chapter 3/);
  assert.doesNotMatch(text, /Nobody Reads This/);
  assert.doesNotMatch(text, /All rights reserved/);
  assert.ok(text.includes(`"It's fine," said everyone - loudly...`));
  assert.doesNotMatch(text, /[“’—]/);
});

test("epub: matches the Python extractor's output", async () => {
  const out = join(dir, "py.txt");
  const epub = join(dir, "cmp.epub");
  let r = spawnSync("python3", [join(here, "epub_fixture.py"), epub, "3"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  r = spawnSync("python3", ["-m", "bad_fanfic", "extract", epub, "-o", out],
    { encoding: "utf8", cwd: join(here, "..") });
  assert.equal(r.status, 0, r.stderr);
  const b = readFileSync(epub);
  const js = await epubToText(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  assert.equal(js, readFileSync(out, "utf8").trim());
});

test("epub: skip options", async () => {
  const text = await epubToText(fixture("s.epub"), { skipDocs: 3, skipTail: 1 });
  assert.match(text, /Chapter 2/);
  assert.doesNotMatch(text, /Chapter 1|Chapter 3/);
});

test("epub: DRM is rejected", async () => {
  await assert.rejects(epubToText(fixture("d.epub", 3, true)), /DRM/);
});

test("epub: non-zip input gives a clear error", async () => {
  await assert.rejects(epubToText(new TextEncoder().encode("hello world, not a zip file at all").buffer), /not a zip/);
});

test("chain: sentences, start-of-sentence, and no verbatim copying", async () => {
  const text = await epubToText(fixture("c.epub", 6));
  const chain = new Chain(text, { maxOrder: 3, overlapRun: 6 });
  assert.ok(chain.usable);
  let made = 0;
  for (let i = 0; i < 40; i++) {
    const s = chain.sentence({ order: 3 });
    if (!s) continue;
    made++;
    assert.ok(s.length >= 5);
    assert.ok(/[.!?]["')\]]*$/.test(s.at(-1)));
    assert.equal(chain.copiesSource(s), false);
  }
  assert.ok(made > 10, `only ${made} sentences generated`);
});

test("chain: suggestions fill the board and respect context", async () => {
  const text = await epubToText(fixture("k.epub", 6));
  const chain = new Chain(text);
  const start = chain.suggestions([], { count: 18 });
  assert.ok(start.length > 0 && start.length <= 18);
  assert.equal(new Set(start).size, start.length, "suggestions are unique");
  const afterThe = chain.suggestions(["The", "wizard"], { order: 2, count: 18 });
  assert.ok(afterThe.length > 0 && afterThe.length <= 18);
  assert.ok(afterThe.slice(0, 8).some((w) => /^(quietly|angrily|forgot|politely|secretly|tripped|sang|bargained)/.test(w)),
    `unexpected top suggestions: ${afterThe.slice(0, 8)}`);
  // unseen context still returns something
  assert.ok(chain.suggestions(["zzqx"], { count: 18 }).length > 0);
});
