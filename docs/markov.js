// Word-level Markov chain used by the browser demo. Same idea as
// bad_fanfic/markov.py, plus a "predictive keyboard" API (suggestions()).

const SENTENCE_END = /[.!?]["')\]]*$/;

// Capitalised words that are sentence openers rather than names, and nouns too vague for a title.
const TITLE_STOP = new Set(("The A An And But Then When What Where Why How Who Which There This That These " +
  "Those They Them Their His Her She He It Its We You Your Our Not No Yes Well Oh Now So If As At In On Of " +
  "For With From Into Just Still Even Only Some Any All Every One Two Three After Before While Because Mr Mrs " +
  "Did Does Don Was Were Had Have Has Are Can Could Would Should Will May Might Must Maybe Okay Sir Please " +
  "Chapter Professor Uncle Aunt Lord Lady Madam Captain Doctor Miss Mostly Death Dark Yeah Look Good Right " +
  "same other first last next rest only whole time other back moment others place thing things " +
  "floor sort kind side middle very most front past world end second third fourth fifth best right left fact rest entire main little small next previous least same").split(" "));

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

  // A fanfic title built from the source's own vocabulary: frequent capitalised
  // words (mostly names) and the words that most often follow "the" (mostly nouns).
  title() {
    if (!this._titleWords) {
      if (!this._top) {
        this._top = [...this.unigrams].sort((a, b) => b[1] - a[1]).slice(0, 300).map((e) => e[0]);
      }
      // Names: capitalised words that also turn up mid-sentence ("said Harry", "and Ron").
      const midSentence = new Set();
      for (const key of ["said", "and", "to", "with", "at", "of", "for", "asked"]) {
        for (const w of this.tables[1].get(key)?.keys() || []) midSentence.add(w.replace(/[^A-Za-z]+$/, ""));
      }
      const names = [...new Set(this._top.map((w) => w.replace(/[^A-Za-z]+$/, "")))]
        .filter((w) => /^[A-Z][a-z]{2,}$/.test(w) && !TITLE_STOP.has(w) && midSentence.has(w));
      // Nouns: words that follow "the" and sometimes end a phrase there ("the door."),
      // which adjectives and numbers rarely do. Singular only, so "A ..." reads right.
      const total = new Map();
      const ended = new Set();
      for (const [token, c] of this.tables[1].get("the") || []) {
        const m = /^([a-z]{4,})([.,!?;:]?)["')]*$/.exec(token);
        if (!m || TITLE_STOP.has(m[1]) || /[^s]s$/.test(m[1])) continue;
        total.set(m[1], (total.get(m[1]) || 0) + c);
        if (m[2]) ended.add(m[1]);
      }
      const nouns = [...total].filter(([w]) => ended.has(w)).sort((a, b) => b[1] - a[1])
        .slice(0, 150).map(([w]) => w[0].toUpperCase() + w.slice(1));
      this._titleWords = { names, nouns };
    }
    const { names, nouns } = this._titleWords;
    if (!nouns.length) return "Untitled chapter";
    const pick = (list) => list[Math.floor(Math.random() * list.length)];
    const noun = () => pick(nouns);
    const name = () => (names.length ? pick(names) : noun());
    const templates = [
      () => `${name()} and the ${noun()} of ${noun()}`,
      () => `${name()} and the ${noun()}`,
      () => `The ${noun()} of ${name()}`,
      () => `The ${noun()} ${noun()}`,
      () => `${name()} versus the ${noun()}`,
      () => `${name()}, ${name()} and the ${noun()}`,
      () => { const n = noun(); return `${/^[AEIOU]/.test(n) ? "An" : "A"} ${n} for ${name()}`; },
    ];
    for (let i = 0; i < 10; i++) {
      const t = pick(templates)();
      if (new Set(t.split(/\W+/)).size === t.split(/\W+/).length) return t; // no repeated words
    }
    return `The ${noun()}`;
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
