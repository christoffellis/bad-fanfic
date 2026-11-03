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
  "dark dead living wrong floor sort kind side middle very most front past world end second third fourth fifth best right left fact rest entire main little small next previous least same").split(" "));

// Words nonsense() never swaps out: the grammar it keeps while the sense goes.
const FUNCTION_WORDS = new Set(("the a an and but or of to in on at for with from into onto by as up down out off " +
  "over under than then that this these those there here his her its their our your my he she it they we you i me " +
  "him them us was were is are be been had has have did do does not no so if when while what who which how all very " +
  "just said asked would could should will can now one some any other each every more most much many few own same " +
  "such only even still back away again too").split(" "));
const DETERMINERS = new Set("the a an his her their my your its our this that".split(" "));
const SUBJECTS = { he: "him", she: "her", they: "them", i: "me", we: "us", it: "it", you: "you" };
const QUOTE = /["'‘’“”]/;

// A token as [leading punctuation, word, trailing punctuation], or null ("Harry's", "-").
const parts = (token) => /^([^A-Za-z]*)([A-Za-z][A-Za-z-]*)([^A-Za-z]*)$/.exec(token)?.slice(1) || null;
const pick = (list) => list[Math.floor(Math.random() * list.length)];

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

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

const weightedKey = (entries) => (entries.length ? entries[weightedPick(entries)][0] : null);

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

  // How well the chain backs a sentence: the mean context length that predicted each word.
  _support(words) {
    let sum = 0;
    for (let i = 1; i < words.length; i++) {
      let k = Math.min(this.maxOrder, i);
      while (k > 0 && !this.tables[k].get(words.slice(i - k, i).join(" ").toLowerCase())?.has(words[i])) k--;
      sum += k;
    }
    return sum / Math.max(1, words.length - 1);
  }

  // What can be swapped at position i: "noun" (after a determiner, ending its phrase)
  // or "name". Null for everything else.
  _slot(words, i) {
    const p = parts(words[i]);
    if (!p || p[1].length < 3 || FUNCTION_WORDS.has(p[1].toLowerCase()) || (p[0] && i > 0)) return null;
    const prev = i > 0 ? parts(words[i - 1]) : null;
    const next = i + 1 < words.length ? parts(words[i + 1]) : null;
    const endsPhrase = p[2] || !next || FUNCTION_WORDS.has(next[1].toLowerCase());
    if (prev && !prev[2] && DETERMINERS.has(prev[1].toLowerCase()) && this._lexicon().nouns.has(p[1]) && endsPhrase) {
      return "noun";
    }
    if (this._lexicon().nameSet.has(p[1]) && !(prev && DETERMINERS.has(prev[1].toLowerCase()))) return "name";
    return null;
  }

  // "Harry looked at the wand." -> "The wand looked at Harry."
  _flip(words) {
    const s = parts(words[0]);
    if (!s || s[0] || s[2]) return null;
    const object = SUBJECTS[s[1].toLowerCase()] || (this._lexicon().nameSet.has(s[1]) && s[1]);
    if (!object) return null;
    const spots = [];
    for (let j = 3; j < words.length; j++) {
      // "a bottle of ink" stays put: moving just "bottle" would strand "of ink"
      if (/^(the|a|an)$/i.test(words[j - 1]) && this._slot(words, j) === "noun"
        && !/^of$/i.test(words[j + 1] || "")) spots.push(j);
    }
    if (!spots.length) return null;
    const j = pick(spots);
    const [, noun, suffix] = parts(words[j]);
    const det = words[j - 1].toLowerCase();
    return [det[0].toUpperCase() + det.slice(1), noun, ...words.slice(1, j - 1), object + suffix, ...words.slice(j + 1)];
  }

  // Swap two nouns, or two names, that sit apart: "the end of the lane" -> "the lane of the end".
  _swap(words) {
    const pairs = [];
    for (let i = 0; i < words.length; i++) {
      const kind = this._slot(words, i);
      if (kind !== "noun" && kind !== "name") continue;
      for (let j = i + 3; j < words.length; j++) {
        if (this._slot(words, j) === kind && parts(words[j])[1] !== parts(words[i])[1]) pairs.push([i, j]);
      }
    }
    if (!pairs.length) return null;
    const [i, j] = pick(pairs);
    const [pi, ci, si] = parts(words[i]);
    const [pj, cj, sj] = parts(words[j]);
    const out = words.slice();
    out[i] = pi + cj + si;
    out[j] = pj + ci + sj;
    return out;
  }

  // Replace the word at i with one that fits its neighbours but not the sense:
  // a noun the wider context never predicts, or a thing where a name was.
  _substitute(words, i) {
    const kind = this._slot(words, i);
    const [pre, core, suf] = parts(words[i]);
    const { nouns } = this._lexicon();
    const used = new Set(words.map((w) => parts(w)?.[1].toLowerCase()));
    if (kind === "name") {
      // "Harry didn't know what to say." -> "The cauldron didn't know what to say."
      const noun = weightedKey([...nouns].filter(([w]) => !used.has(w)).slice(0, 150));
      if (!noun) return null;
      const det = i === 0 || SENTENCE_END.test(words[i - 1]) ? "The" : "the";
      return [...words.slice(0, i), pre + det, noun + suf, ...words.slice(i + 1)];
    }
    const left = this.tables[1].get(words[i - 1].toLowerCase());
    const wide = i >= 2 ? this.tables[2].get(words.slice(i - 2, i).join(" ").toLowerCase()) : null;
    const after = (x) => i + 1 >= words.length || this.tables[1].get(x.toLowerCase())?.has(words[i + 1]);
    const options = [];
    for (const [x, c] of left || []) {
      const p = parts(x);
      if (!p || p[0] !== pre || p[2] !== suf || used.has(p[1].toLowerCase()) || wide?.has(x) || !after(x)) continue;
      if (!nouns.has(p[1])) continue;
      options.push([x, Math.sqrt(Number(c))]);
    }
    const x = weightedKey(options);
    if (!x) return null;
    const out = words.slice();
    out[i] = x;
    if (kind === "noun" && /^an?$/i.test(words[i - 1])) {
      out[i - 1] = (/^[aeiou]/.test(x) ? "an" : "a").replace("a", words[i - 1][0]);
    }
    return out;
  }

  // Auto-write, Botnik style: a short, well-formed sentence with its sense knocked
  // loose by `edits` swaps, like "The wand looked at Harry." Returns words or null.
  nonsense({ edits = 1, tries = 60 } = {}) {
    const pool = [];
    for (let t = 0; t < tries && pool.length < 18; t++) {
      const s = this.sentence({ order: this.maxOrder, maxWords: 14, minWords: 4, tries: 5 });
      // dialogue fragments make poor templates; so do sentences with nothing to swap
      if (!s || !/^[A-Z]/.test(s[0]) || QUOTE.test(s.join(" ").replace(/\w['\u2019]\w/g, ""))) continue;
      if (s.some((_, i) => this._slot(s, i))) pool.push(s);
    }
    if (!pool.length) return null;
    // the best-backed third reads as proper sentences; picking within it keeps variety
    pool.sort((a, b) => this._support(b) - this._support(a));
    let words = pick(pool.slice(0, Math.ceil(pool.length / 3)));
    for (let n = 0; n < edits; n++) {
      let next = n === 0 && Math.random() < 0.5 ? this._flip(words) : null;
      if (!next && Math.random() < 0.25) next = this._swap(words);
      for (const i of shuffle(words.map((_, i) => i).filter((i) => this._slot(words, i)))) {
        if (next) break;
        next = this._substitute(words, i);
      }
      if (next) words = next;
    }
    return words;
  }

  // The source's main names and concrete nouns, shared by title() and nonsense().
  _lexicon() {
    if (!this._lex) {
      if (!this._top) {
        this._top = [...this.unigrams].sort((a, b) => b[1] - a[1]).slice(0, 300).map((e) => e[0]);
      }
      // Names: frequent capitalised words that also turn up mid-sentence ("said Harry", "and Ron").
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
        if (!m || TITLE_STOP.has(m[1]) || /[^s]s$/.test(m[1]) || /(ing|ly)$/.test(m[1])) continue;
        total.set(m[1], (total.get(m[1]) || 0) + Number(c));
        if (m[2]) ended.add(m[1]);
      }
      const nouns = new Map([...total].filter(([w]) => ended.has(w)).sort((a, b) => b[1] - a[1]).slice(0, 400));
      this._lex = { names, nameSet: new Set(names), nouns };
    }
    return this._lex;
  }

  // A fanfic title built from the source's own vocabulary: frequent capitalised
  // words (mostly names) and the words that most often follow "the" (mostly nouns).
  title() {
    const names = this._lexicon().names;
    const nouns = [...this._lexicon().nouns.keys()].slice(0, 150).map((w) => w[0].toUpperCase() + w.slice(1));
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
