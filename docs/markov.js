// Word-level Markov chain used by the browser demo. Same idea as
// bad_fanfic/markov.py, plus a "predictive keyboard" API (suggestions()).

const SENTENCE_END = /[.!?]["')\]]*$/;

export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function weightedPick(entries) {
  let total = 0;
  for (const [, w] of entries) total += w;
  let r = Math.random() * total;
  for (let i = 0; i < entries.length; i++) {
    r -= entries[i][1];
    if (r <= 0) return i;
  }
  return entries.length - 1;
}

export class Chain {
  // maxOrder: longest context (in words) the tables remember.
  // overlapRun: reject sentences that copy this many words in a row from the source.
  constructor(text, { maxOrder = 3, overlapRun = 12 } = {}) {
    this.maxOrder = maxOrder;
    this.overlapRun = overlapRun;
    this.tables = Array.from({ length: maxOrder + 1 }, () => new Map());
    this.starts = [];
    this.unigrams = new Map();
    this.runs = new Set();
    this.wordCount = 0;
    this._top = null;

    for (const para of text.split(/\n+/)) {
      const words = para.split(/\s+/).filter(Boolean);
      this.wordCount += words.length;
      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        this.unigrams.set(w, (this.unigrams.get(w) || 0) + 1);
        for (let k = 1; k <= maxOrder && i - k >= 0; k++) {
          const key = words.slice(i - k, i).join(" ").toLowerCase();
          let row = this.tables[k].get(key);
          if (!row) this.tables[k].set(key, (row = new Map()));
          row.set(w, (row.get(w) || 0) + 1);
        }
        if (i + maxOrder <= words.length && (i === 0 || SENTENCE_END.test(words[i - 1]))) {
          this.starts.push(words.slice(i, i + maxOrder));
        }
      }
      if (overlapRun) {
        for (let i = 0; i + overlapRun <= words.length; i++) {
          this.runs.add(fnv1a(words.slice(i, i + overlapRun).join(" ")));
        }
      }
    }
  }

  // A prebuilt model from `python -m bad_fanfic markov corpus.txt --export x.json`.
  // It is pruned, so the verbatim-copy check is unnecessary (and its data isn't shipped).
  static fromJSON(model) {
    if (model?.format !== "bad-fanfic-markov" || model.version !== 1) {
      throw new Error("not a bad-fanfic Markov model");
    }
    const chain = new Chain("", { maxOrder: model.maxOrder, overlapRun: 0 });
    model.tables.forEach((table, i) => {
      const map = chain.tables[i + 1];
      for (const [ctx, row] of Object.entries(table)) map.set(ctx, new Map(Object.entries(row)));
    });
    for (const [start, count] of Object.entries(model.starts)) {
      const words = start.split(" ");
      for (let i = 0; i < count; i++) chain.starts.push(words);
    }
    chain._top = model.top.slice();
    chain.wordCount = model.wordCount;
    chain.name = model.name;
    return chain;
  }

  get usable() {
    return this.starts.length > 0;
  }

  _row(words, order) {
    for (let k = Math.min(order, words.length, this.maxOrder); k >= 1; k--) {
      const row = this.tables[k].get(words.slice(-k).join(" ").toLowerCase());
      if (row) return row;
    }
    return null;
  }

  copiesSource(words) {
    const n = this.overlapRun;
    if (!n) return false;
    for (let i = 0; i + n <= words.length; i++) {
      if (this.runs.has(fnv1a(words.slice(i, i + n).join(" ")))) return true;
    }
    return false;
  }

  // Auto-write: returns an array of words forming one sentence, or null.
  sentence({ order = 2, maxWords = 45, minWords = 5, tries = 80 } = {}) {
    if (!this.usable) return null;
    for (let t = 0; t < tries; t++) {
      const seed = this.starts[Math.floor(Math.random() * this.starts.length)];
      const words = seed.slice(0, order);
      while (words.length < maxWords) {
        const row = this._row(words, order);
        if (!row) break;
        const entries = [...row];
        words.push(entries[weightedPick(entries)][0]);
        if (words.length >= minWords && SENTENCE_END.test(words[words.length - 1])) {
          if (!this.copiesSource(words)) return words;
          break;
        }
      }
    }
    return null;
  }

  // Predictive keyboard: the words most likely to follow `words`, topped up
  // with weighted-random picks so the board always has something odd on it.
  suggestions(words, { order = 2, count = 18 } = {}) {
    const weights = new Map();
    if (words.length === 0) {
      for (const s of this.starts) weights.set(s[0], (weights.get(s[0]) || 0) + 1);
    } else {
      for (let k = Math.min(order, words.length, this.maxOrder); k >= 1; k--) {
        const row = this.tables[k].get(words.slice(-k).join(" ").toLowerCase());
        if (!row) continue;
        let total = 0;
        for (const c of row.values()) total += c;
        // longer matching context counts for more
        for (const [w, c] of row) weights.set(w, (weights.get(w) || 0) + (c / total) * k);
      }
    }

    const ranked = [...weights].sort((a, b) => b[1] - a[1]);
    const picks = ranked.slice(0, Math.ceil(count / 2)).map((e) => e[0]);
    const likely = picks.length; // the rest of the board is wildcards
    const rest = ranked.slice(picks.length);
    while (picks.length < count && rest.length) {
      picks.push(rest.splice(weightedPick(rest), 1)[0][0]);
    }
    if (picks.length < count) {
      if (!this._top) {
        this._top = [...this.unigrams].sort((a, b) => b[1] - a[1]).slice(0, 300).map((e) => e[0]);
      }
      const pool = this._top.filter((w) => !picks.includes(w));
      while (picks.length < count && pool.length) {
        picks.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
      }
    }
    picks.likely = likely;
    return picks;
  }
}
