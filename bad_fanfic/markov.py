"""Word-level Markov chain generator: the Botnik-style 'almost makes sense' route.

Pure standard library. The same algorithm runs in the browser demo (docs/markov.js).

Usage:
    python -m bad_fanfic markov corpus.txt -n 10
    python -m bad_fanfic markov corpus.txt -n 5 --state-size 1 --paragraph 4
    python -m bad_fanfic markov corpus.txt --start "Harry" -n 5
"""

from __future__ import annotations

import argparse
import random
import re
import sys
from pathlib import Path

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
    args = ap.parse_args(argv)

    if args.seed is not None:
        random.seed(args.seed)
    chain = Chain(Path(args.corpus).read_text(encoding="utf-8"),
                  args.state_size, args.overlap_run)
    if not chain.starts:
        sys.exit("corpus has no usable sentences")

    produced = attempts = 0
    while produced < args.count and attempts < args.count * 20:
        attempts += 1
        parts = [chain.sentence(args.start) for _ in range(args.paragraph)]
        if all(parts):
            print(" ".join(parts) + "\n")
            produced += 1
    if produced < args.count:
        print("(ran out of tries; try a lower --state-size or --start word that "
              "appears in the corpus)", file=sys.stderr)


if __name__ == "__main__":
    main()
