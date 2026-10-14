import { Chain } from "./markov.js?v=2";
import { epubToText } from "./epub.js";

const $ = (sel) => document.querySelector(sel);
const page = $("#page");
const keys = $("#keys");
const statusEl = $("#status");
const sourceEl = $("#source");
const wordcountEl = $("#wordcount");
const titleEl = $("#doc-title");
const neuralStatus = $("#neural-status");
const orderInputs = [...document.querySelectorAll('input[name="order"]')];

const params = new URLSearchParams(location.search);

let chain = null;
let tokens = []; // { w: string, picked: boolean }
const history = []; // how many tokens each action added, for undo
const chains = new Map(); // source value -> Chain, so switching back is instant
let suggestions = [];

/* ---------- theme ---------- */

$("#theme").addEventListener("click", () => {
  const root = document.documentElement;
  const dark = root.dataset.theme
    ? root.dataset.theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
  try { localStorage.setItem("theme", root.dataset.theme); } catch {}
});

/* ---------- manuscript ---------- */

function render() {
  const frag = document.createDocumentFragment();
  for (const t of tokens) {
    const span = document.createElement("span");
    span.className = t.picked ? "w picked" : "w";
    span.textContent = t.w;
    frag.append(span, " ");
  }
  page.replaceChildren(frag);
  page.scrollTop = page.scrollHeight;
  const n = tokens.length;
  wordcountEl.textContent = `${n.toLocaleString()} word${n === 1 ? "" : "s"}`;
}

function add(words, picked) {
  if (!words || !words.length) return;
  for (const w of words) tokens.push({ w, picked });
  history.push(words.length);
  render();
  refreshKeys();
}

function undo() {
  const n = history.pop();
  if (!n) return;
  tokens.length -= n;
  render();
  refreshKeys();
}

const currentWords = () => tokens.map((t) => t.w);
const order = () => Number(orderInputs.find((i) => i.checked)?.value || 2);

function newTitle() {
  if (chain) titleEl.textContent = chain.title();
}
titleEl.addEventListener("click", newTitle);

function refreshKeys() {
  if (!chain) { suggestions = []; keys.replaceChildren(); return; }
  suggestions = chain.suggestions(currentWords(), { order: order(), count: 18 });
  keys.replaceChildren(...suggestions.map((w, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = i < suggestions.likely ? "key" : "key wild";
    if (i < 9) {
      const num = document.createElement("span");
      num.className = "num";
      num.textContent = i + 1;
      num.setAttribute("aria-hidden", "true");
      b.append(num);
    }
    b.append(w);
    b.setAttribute("aria-label", w);
    b.addEventListener("click", () => add([w], true));
    return b;
  }));
}

/* ---------- sources ---------- */

function useChain(next, message) {
  chain = next;
  const max = chain.maxOrder;
  for (const input of orderInputs) {
    input.disabled = Number(input.value) > max;
    input.parentElement.title = input.disabled ? `This model remembers at most ${max} words of context` : "";
  }
  if (order() > max) {
    const allowed = orderInputs.filter((i) => !i.disabled);
    allowed[allowed.length - 1].checked = true;
  }
  if (!tokens.length) newTitle();
  statusEl.textContent = message;
  refreshKeys();
}

function addOption(value, label, before = null) {
  let opt = [...sourceEl.options].find((o) => o.value === value);
  if (!opt) {
    opt = new Option(label, value);
    sourceEl.insertBefore(opt, before);
  }
  opt.textContent = label;
  return opt;
}

async function selectSource(value) {
  sourceEl.value = value;
  const cached = chains.get(value);
  const describe = (c) => value === "sample"
    ? "Original sample text written for this demo."
    : `${c.name || "Model"}: ${c.wordCount.toLocaleString()} words of source text.`;
  if (cached) { useChain(cached, describe(cached)); return; }

  statusEl.textContent = "Loading…";
  try {
    let next;
    if (value === "sample") {
      const res = await fetch("sample.txt");
      if (!res.ok) throw new Error(res.statusText);
      next = new Chain(await res.text(), { maxOrder: 5, overlapRun: 12 });
    } else {
      const res = await fetch(`models/${value.slice("model:".length)}`, { cache: "no-cache" });
      if (!res.ok) throw new Error(res.statusText);
      next = Chain.fromJSON(await res.json());
    }
    chains.set(value, next);
    if (sourceEl.value === value) useChain(next, describe(next));
  } catch (err) {
    statusEl.textContent = `Couldn't load that source (${err.message}).`;
  }
}

async function loadSources() {
  let models = [];
  try {
    const res = await fetch("models/index.json", { cache: "no-cache" });
    if (res.ok) models = await res.json();
  } catch { /* no prebuilt models: the sample still works */ }
  for (const m of models) addOption(`model:${m.file}`, m.name);
  addOption("sample", "Built-in sample (original text)");

  const wanted = params.get("source");
  const values = [...sourceEl.options].map((o) => o.value);
  await selectSource(values.includes(wanted) ? wanted : values[0]);
}

sourceEl.addEventListener("change", () => selectSource(sourceEl.value));

/* ---------- your own books ---------- */

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

async function loadFiles(fileList) {
  const files = [...fileList].filter((f) => /\.(epub|txt)$/i.test(f.name));
  if (!files.length) { statusEl.textContent = "Choose .epub or .txt files."; return; }

  statusEl.textContent = `Reading ${files.length} file${files.length > 1 ? "s" : ""}…`;
  await nextFrame();
  const texts = [];
  const failed = [];
  for (const f of files) {
    try {
      const text = /\.epub$/i.test(f.name) ? await epubToText(await f.arrayBuffer()) : await f.text();
      if (text.trim()) texts.push(text);
      else failed.push(`${f.name} (no text found)`);
    } catch (err) {
      failed.push(`${f.name} (${err.message})`);
    }
  }
  if (!texts.length) {
    statusEl.textContent = `Couldn't read any text. ${failed.join("; ")}`;
    return;
  }

  statusEl.textContent = "Building the word chain…";
  await nextFrame();
  const built = new Chain(texts.join("\n\n"), { maxOrder: 5, overlapRun: 12 });
  if (!built.usable) { statusEl.textContent = "That text is too short to learn from."; return; }

  const label = `Your books (${texts.length} file${texts.length > 1 ? "s" : ""})`;
  addOption("own", label, sourceEl.options[0] || null);
  chains.set("own", built);
  sourceEl.value = "own";
  const summary = `${label}: ${built.wordCount.toLocaleString()} words.`;
  useChain(built, failed.length ? `${summary} Skipped: ${failed.join("; ")}` : summary);
}

$("#files").addEventListener("change", (e) => { loadFiles(e.target.files); e.target.value = ""; });

let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
  e.preventDefault();
  dragDepth++;
  document.body.classList.add("dragging");
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); }
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  if (e.dataTransfer?.files.length) loadFiles(e.dataTransfer.files);
});

/* ---------- controls ---------- */

for (const input of orderInputs) input.addEventListener("change", refreshKeys);

$("#auto").addEventListener("click", () => {
  if (!chain) { statusEl.textContent = "Pick a source first."; return; }
  const sentence = chain.sentence({ order: order() });
  if (sentence) add(sentence, false);
  else statusEl.textContent = "Couldn't build a sentence from that. Try the Chaos setting.";
});

$("#undo").addEventListener("click", undo);

$("#clear").addEventListener("click", () => {
  if (tokens.length > 40 && !confirm("Clear the whole chapter?")) return;
  tokens = [];
  history.length = 0;
  render();
  refreshKeys();
  newTitle();
});

$("#copy").addEventListener("click", async () => {
  const words = currentWords().join(" ");
  if (!words) return;
  const text = `${titleEl.textContent}\n\n${words}`;
  try {
    await navigator.clipboard.writeText(text);
    statusEl.textContent = "Copied your chapter.";
  } catch {
    statusEl.textContent = "Couldn't copy automatically. Select the text and copy it yourself.";
  }
});

$("#own").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#ownword");
  const words = input.value.split(/\s+/).filter(Boolean);
  input.value = "";
  add(words, true);
});

document.addEventListener("keydown", (e) => {
  const typing = e.target.closest?.("input, select, textarea, [contenteditable]");
  if (typing || e.altKey) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undo();
  } else if (!e.ctrlKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
    const w = suggestions[Number(e.key) - 1];
    if (w) { e.preventDefault(); add([w], true); }
  }
});

/* ---------- neural mode (Transformers.js + Hugging Face) ---------- */

let generator = null;
let loadedModel = "";
const modelInput = $("#model");
const loadBtn = $("#load-model");
const continueBtn = $("#continue");

if (params.get("model")) {
  modelInput.value = params.get("model");
  $("#neural").open = true;
}

function setNeural(msg) { neuralStatus.textContent = msg; }

async function loadModel() {
  const id = modelInput.value.trim();
  if (!id) { setNeural("Enter a Hugging Face model id, like Xenova/distilgpt2."); return; }
  loadBtn.disabled = continueBtn.disabled = true;
  try {
    setNeural("Loading Transformers.js…");
    const tf = await import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3");
    tf.env.allowLocalModels = false;
    const progress_callback = (p) => {
      if (p.status === "progress" && p.file) setNeural(`Downloading ${p.file}: ${Math.round(p.progress)}%`);
    };
    try {
      generator = await tf.pipeline("text-generation", id, { dtype: "q8", progress_callback });
    } catch {
      generator = await tf.pipeline("text-generation", id, { dtype: "fp32", progress_callback });
    }
    loadedModel = id;
    setNeural(`Model ready: ${id}`);
    continueBtn.disabled = false;
  } catch (err) {
    generator = null;
    setNeural(`Couldn't load ${id}. Check that the repo exists and includes ONNX weights. (${err.message})`);
  } finally {
    loadBtn.disabled = false;
  }
}

async function continuePage() {
  if (!generator) return;
  continueBtn.disabled = true;
  setNeural("Writing…");
  try {
    const prompt = currentWords().slice(-120).join(" ") || "Chapter One\n\n";
    const words = Math.max(10, Math.min(200, Number($("#len").value) || 60));
    const out = await generator(prompt, {
      max_new_tokens: Math.round(words * 1.4),
      do_sample: true,
      temperature: Number($("#temp").value) || 1,
      top_k: 50,
      repetition_penalty: 1.1,
    });
    let text = String(out[0].generated_text);
    if (text.startsWith(prompt)) text = text.slice(prompt.length);
    add(text.split(/\s+/).filter(Boolean), false);
    setNeural(`Model ready: ${loadedModel}`);
  } catch (err) {
    setNeural(`Generation failed. (${err.message})`);
  } finally {
    continueBtn.disabled = false;
  }
}

loadBtn.addEventListener("click", loadModel);
continueBtn.addEventListener("click", continuePage);

/* ---------- go ---------- */

render();
loadSources();
