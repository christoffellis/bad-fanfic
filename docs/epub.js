// Reads DRM-free epubs entirely in the browser: no libraries, no uploads.
// An epub is a zip of XHTML files, and browsers can inflate zip data natively
// with DecompressionStream.

const FONT_ALGOS = [
  "http://www.idpf.org/2008/embedding",
  "http://ns.adobe.com/pdf/enc#RC",
];
const JUNK =
  /(cover|toc|contents|copyright|title|dedicat|acknowledg|about|author|also|praise|nav|colophon|imprint|license|newsletter|excerpt|preview)/i;
const SMART = {
  "‘": "'", "’": "'", "‚": "'", "‛": "'",
  "“": '"', "”": '"', "„": '"',
  "–": "-", "—": "-", "―": "-",
  "…": "...", " ": " ", "​": "", "﻿": "",
};
const NAMED = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
};

export async function readZip(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let eocd = -1;
  const floor = Math.max(0, bytes.length - 22 - 65535);
  for (let i = bytes.length - 22; i >= floor; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("This doesn't look like an epub (not a zip file).");

  const count = view.getUint16(eocd + 10, true);
  let off = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(off, true) !== 0x02014b50) throw new Error("Corrupt zip directory.");
    const method = view.getUint16(off + 10, true);
    const csize = view.getUint32(off + 20, true);
    const nameLen = view.getUint16(off + 28, true);
    const extraLen = view.getUint16(off + 30, true);
    const commentLen = view.getUint16(off + 32, true);
    const header = view.getUint32(off + 42, true);
    const name = decoder.decode(bytes.subarray(off + 46, off + 46 + nameLen));
    entries.set(name, { method, csize, header });
    off += 46 + nameLen + extraLen + commentLen;
  }

  async function read(name) {
    const e = entries.get(name);
    if (!e) throw new Error(`Missing ${name} in epub.`);
    const start = e.header + 30 + view.getUint16(e.header + 26, true) + view.getUint16(e.header + 28, true);
    const data = bytes.subarray(start, start + e.csize);
    if (e.method === 0) return data;
    if (e.method === 8) {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    throw new Error(`Unsupported zip compression (${e.method}).`);
  }
  return { has: (n) => entries.has(n), read };
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return m ? (m[1] ?? m[2]) : "";
}

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e) => {
    if (e[0] === "#") {
      const cp = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return ""; }
    }
    return NAMED[e.toLowerCase()] ?? whole;
  });
}

export function htmlParagraphs(html) {
  let s = html.replace(/<(head|script|style|nav)\b[\s\S]*?<\/\1\s*>/gi, "");
  s = s.replace(/<\/?(p|div|h[1-6]|li|blockquote|br|tr|section)\b[^>]*>/gi, "\n");
  s = decodeEntities(s.replace(/<[^>]+>/g, ""));
  return s.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
}

export function normalize(text) {
  for (const [from, to] of Object.entries(SMART)) text = text.split(from).join(to);
  return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function resolve(base, href) {
  const parts = (base ? base.split("/") : []);
  for (const seg of decodeURIComponent(href.split("#")[0]).split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

export async function epubToText(buffer, { skipDocs = 0, skipTail = 0, minChars = 400, keepJunk = false } = {}) {
  const zip = await readZip(buffer);
  const text = async (name) => new TextDecoder().decode(await zip.read(name));

  if (zip.has("META-INF/encryption.xml")) {
    const enc = await text("META-INF/encryption.xml");
    for (const m of enc.matchAll(/<(?:\w+:)?EncryptionMethod\b[^>]*>/g)) {
      const algo = attr(m[0], "Algorithm");
      if (!FONT_ALGOS.some((a) => algo.startsWith(a))) {
        throw new Error("This epub is DRM-protected. Remove the DRM first.");
      }
    }
  }

  const container = await text("META-INF/container.xml");
  const rootTag = container.match(/<rootfile\b[^>]*>/);
  if (!rootTag) throw new Error("Epub has no package file.");
  const opfPath = attr(rootTag[0], "full-path");
  const base = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/")) : "";
  const opf = await text(opfPath);

  const manifest = new Map();
  for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
    manifest.set(attr(m[0], "id"), { href: attr(m[0], "href"), type: attr(m[0], "media-type") });
  }
  let docs = [];
  for (const m of opf.matchAll(/<itemref\b[^>]*>/g)) {
    if (attr(m[0], "linear") === "no") continue;
    const id = attr(m[0], "idref");
    const item = manifest.get(id);
    if (!item || !item.type.includes("html")) continue;
    const path = resolve(base, item.href);
    if (zip.has(path)) docs.push({ path, id });
  }
  if (skipTail) docs = docs.slice(0, -skipTail);
  docs = docs.slice(skipDocs);

  const chapters = [];
  for (const { path, id } of docs) {
    const file = path.slice(path.lastIndexOf("/") + 1);
    if (!keepJunk && JUNK.test(`${file} ${id}`)) continue;
    const body = htmlParagraphs(await text(path)).join("\n");
    if (body.length < minChars && !keepJunk) continue;
    chapters.push(body);
  }
  return normalize(chapters.join("\n\n"));
}
