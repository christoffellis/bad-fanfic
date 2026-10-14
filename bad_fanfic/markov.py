"""Word-level Markov chain generator: the Botnik-style 'almost makes sense' route.

Pure standard library. The same algorithm runs in the browser demo (docs/markov.js).

Usage:
    python -m bad_fanfic markov corpus.txt -n 10
    python -m bad_fanfic markov corpus.txt -n 5 --state-size 1 --paragraph 4
    python -m bad_fanfic markov corpus.txt --start "Harry" -n 5
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
from collections import Counter
from pathlib import Path

from bad_fanfic import output

SENTENCE = re.compile(r"""[^.!?]+(?:[.!?]+["']?|$)""")


def split_sentences(text: str) -> list[list[str]]:
    sentences = []
    for para in text.split("\n"):
        for match in SENTENCE.finditer(para):
            words = match.group(0).split()
            if words:
                sentences.append(words)
    return sentences


class Chain:
    def __init__(self, text: str, state_size: int = 2, overlap_run: int = 12) -> None:
        self.n = state_size
        self.run = overlap_run
        self.next: dict[tuple, list] = {}
        self.starts: list[tuple] = []
        self.by_first: dict[str, list[tuple]] = {}
        self.seen_runs: set[int] = set()

        for words in split_sentences(text):
            if len(words) <= self.n:
                continue
            self.starts.append(tuple(words[: self.n]))
            for i in range(len(words) - self.n + 1):
                state = tuple(words[i: i + self.n])
                following = words[i + self.n] if i + self.n < len(words) else None
                self.next.setdefault(state, []).append(following)
                self.by_first.setdefault(state[0].lower(), []).append(state)
            if overlap_run:
                for i in range(len(words) - overlap_run + 1):
                    self.seen_runs.add(hash(tuple(words[i: i + overlap_run])))

    def _copies_source(self, words: list[str]) -> bool:
        if not self.run:
            return False
        return any(hash(tuple(words[i: i + self.run])) in self.seen_runs
                   for i in range(len(words) - self.run + 1))

    def sentence(self, start: str | None = None, max_words: int = 60,
                 min_words: int = 5, tries: int = 100) -> str | None:
        pool = self.starts
        if start:
            pool = self.by_first.get(start.split()[0].lower(), [])
            if not pool:
                return None
        for _ in range(tries):
            state = random.choice(pool)
            words = list(state)
            while len(words) < max_words:
                following = random.choice(self.next[tuple(words[-self.n:])])
                if following is None:
                    break
                words.append(following)
            else:
                continue  # hit the length cap without ending
            if len(words) >= min_words and not self._copies_source(words):
                return " ".join(words)
        return None


MODEL_FORMAT = "bad-fanfic-markov"
SENTENCE_END = re.compile(r"""[.!?]["')\]]*$""")


def build_model(text: str, name: str, max_order: int = 2, min_count: int = 3,
                top_words: int = 300) -> dict:
    """The browser chain (docs/markov.js) as JSON, minus anything seen fewer
    than `min_count` times. Pruning keeps the file small and stops the model
    from replaying long passages of the source word for word."""
    tables: list[dict[str, Counter]] = [{} for _ in range(max_order + 1)]
    starts: Counter = Counter()
    unigrams: Counter = Counter()
    word_count = 0
    for para in re.split(r"\n+", text):
        words = para.split()
        word_count += len(words)
        for i, w in enumerate(words):
            unigrams[w] += 1
            for k in range(1, max_order + 1):
                if i - k < 0:
                    break
                key = " ".join(words[i - k:i]).lower()
                tables[k].setdefault(key, Counter())[w] += 1
            if i + max_order <= len(words) and (i == 0 or SENTENCE_END.search(words[i - 1])):
                starts[" ".join(words[i:i + max_order])] += 1

    def prune(counter: Counter) -> dict[str, int]:
        return {w: c for w, c in counter.most_common() if c >= min_count}

    pruned_tables = []
    for table in tables[1:]:
        rows = {ctx: prune(row) for ctx, row in table.items()}
        pruned_tables.append({ctx: row for ctx, row in sorted(rows.items()) if row})
    return {
        "format": MODEL_FORMAT,
        "version": 1,
        "name": name,
        "maxOrder": max_order,
        "minCount": min_count,
        "wordCount": word_count,
        "starts": prune(starts),
        "top": [w for w, _ in unigrams.most_common(top_words)],
        "tables": pruned_tables,  # tables[k - 1] maps a k-word context to next-word counts
    }


def export_model(model: dict, path: Path) -> None:
    """Write the model and list it in index.json next to it, which the site reads."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(model, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    index_path = path.parent / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else []
    entry = {"file": path.name, "name": model["name"], "words": model["wordCount"]}
    index = [e for e in index if e["file"] != path.name] + [entry]
    index_path.write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    contexts = sum(len(t) for t in model["tables"])
    print(f"wrote {path} ({path.stat().st_size / 1e6:.1f} MB, {contexts:,} contexts) "
          f"and listed it in {index_path}")


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="bad_fanfic markov", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("corpus", help="text file from `bad_fanfic extract`")
    ap.add_argument("-n", "--count", type=int, default=10)
    ap.add_argument("--state-size", type=int, default=2,
                    help="1 = chaos, 2 = sweet spot, 3 = coherent (and copy-prone)")
    ap.add_argument("--paragraph", type=int, default=1,
                    help="sentences per output item")
    ap.add_argument("--start", help="begin each sentence at this word")
    ap.add_argument("--overlap-run", type=int, default=12,
                    help="reject output sharing this many words in a row with the source "
                         "(0 disables the check)")
    ap.add_argument("--seed", type=int)
    output.add_args(ap)
    ex = ap.add_argument_group("export a model for the browser demo instead of generating")
    ex.add_argument("--export", type=Path, metavar="JSON",
                    help="e.g. docs/models/my-books.json")
    ex.add_argument("--name", help="label shown in the site's model picker")
    ex.add_argument("--min-count", type=int, default=3,
                    help="drop word transitions seen fewer times than this (default 3)")
    ex.add_argument("--max-order", type=int, default=2,
                    help="longest context in words (default 2)")
    args = ap.parse_args(argv)

    if args.export:
        text = Path(args.corpus).read_text(encoding="utf-8")
        name = args.name or args.export.stem.replace("-", " ").title()
        export_model(build_model(text, name, args.max_order, args.min_count), args.export)
        return

    if args.seed is not None:
        random.seed(args.seed)
    chain = Chain(Path(args.corpus).read_text(encoding="utf-8"),
                  args.state_size, args.overlap_run)
    if not chain.starts:
        sys.exit("corpus has no usable sentences")

    texts: list[str] = []
    produced = attempts = 0
    while produced < args.count and attempts < args.count * 20:
        attempts += 1
        parts = [chain.sentence(args.start) for _ in range(args.paragraph)]
        if all(parts):
            texts.append(" ".join(parts))
            print(texts[-1] + "\n")
            produced += 1
    if produced < args.count:
        print("(ran out of tries; try a lower --state-size or --start word that "
              "appears in the corpus)", file=sys.stderr)
    output.save("markov", texts, args)


if __name__ == "__main__":
    main()
