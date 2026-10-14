import { Chain } from "./markov.js";
import { epubToText } from "./epub.js";

const $ = (sel) => document.querySelector(sel);
const page = $("#page");
const keys = $("#keys");
const statusEl = $("#status");
const orderEl = $("#order");
const neuralStatus = $("#neural-status");

const SENSE = { 1: "chaotic", 2: "balanced", 3: "sensible" };
const params = new URLSearchParams(location.search);

let chain = null;
let tokens = []; // { w: string, picked: boolean }
const history = []; // how many tokens each action added, for undo

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
}

function add(words, picked) {
  if (!words || !words.length) return;
  for (const w of words) tokens.push({ w, picked });
  history.push(words.length);
  render();
  refreshKeys();
}

function currentWords() {
  return tokens.map((t) => t.w);
}

function refreshKeys() {
  if (!chain) { keys.replaceChildren(); return; }
  const picks = chain.suggestions(currentWords(), { order: Number(orderEl.value), count: 18 });
  keys.replaceChildren(...picks.map((w, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = i < picks.likely ? "key" : "key wild";
    b.textContent = w;
    b.addEventListener("click", () => add([w], true));
    return b;
  }));
}

/* ---------- loading books ---------- */

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
  const built = new Chain(texts.join("\n\n"), { maxOrder: 3, overlapRun: 12 });
  if (!built.usable) { statusEl.textContent = "That text is too short to learn from."; return; }

  chain = built;
  const summary = `Loaded ${texts.length} file${texts.length > 1 ? "s" : ""} with ${chain.wordCount.toLocaleString()} words.`;
  statusEl.textContent = failed.length ? `${summary} Skipped: ${failed.join("; ")}` : summary;
  refreshKeys();
}

async function loadSample() {
  try {
    const res = await fetch("sample.txt");
    if (!res.ok) throw new Error(res.statusText);
    chain = new Chain(await res.text(), { maxOrder: 3, overlapRun: 12 });
    statusEl.textContent = "Using the built-in sample, which is original text. Choose your own epubs to replace it.";
    refreshKeys();
  } catch {
    statusEl.textContent = "Choose an epub or text file to begin.";
  }
}

/* ---------- controls ---------- */

$("#files").addEventListener("change", (e) => { loadFiles(e.target.files); e.target.value = ""; });

for (const ev of ["dragenter", "dragover"]) {
  window.addEventListener(ev, (e) => { e.preventDefault(); document.body.classList.add("dragging"); });
}
for (const ev of ["dragleave", "drop"]) {
  window.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === "drop" || e.target === document.documentElement) document.body.classList.remove("dragging");
  });
}
window.addEventListener("drop", (e) => { if (e.dataTransfer?.files.length) loadFiles(e.dataTransfer.files); });

orderEl.addEventListener("input", () => {
  orderEl.setAttribute("aria-valuetext", SENSE[orderEl.value]);
  refreshKeys();
});
orderEl.setAttribute("aria-valuetext", SENSE[orderEl.value]);

$("#auto").addEventListener("click", () => {
  if (!chain) { statusEl.textContent = "Choose a book first."; return; }
  const sentence = chain.sentence({ order: Number(orderEl.value) });
  if (sentence) add(sentence, false);
  else statusEl.textContent = "Couldn't build a sentence from that. Try the chaos end of the dial.";
});

$("#undo").addEventListener("click", () => {
  const n = history.pop();
  if (!n) return;
  tokens.length -= n;
  render();
  refreshKeys();
});

$("#clear").addEventListener("click", () => {
  tokens = [];
  history.length = 0;
  render();
  refreshKeys();
});

$("#copy").addEventListener("click", async () => {
  const text = currentWords().join(" ");
  if (!text) return;
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
  input.focus();
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
loadSample();
