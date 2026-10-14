import random
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).parent))

from bad_fanfic.epub_to_text import extract_epub  # noqa: E402
from bad_fanfic.markov import Chain  # noqa: E402
from epub_fixture import build_epub  # noqa: E402


class ExtractTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def test_keeps_chapters_drops_front_matter(self):
        text = extract_epub(build_epub(self.tmp / "a.epub"))
        self.assertIn("Chapter 1", text)
        self.assertIn("Chapter 3", text)
        self.assertNotIn("Nobody Reads This", text)
        self.assertNotIn("All rights reserved", text)

    def test_normalizes_smart_punctuation(self):
        text = extract_epub(build_epub(self.tmp / "a.epub"))
        self.assertIn('"It\'s fine," said everyone - loudly...', text)
        self.assertNotIn("“", text)

    def test_one_paragraph_per_line(self):
        text = extract_epub(build_epub(self.tmp / "a.epub", chapters=1))
        self.assertGreaterEqual(len([l for l in text.splitlines() if l.strip()]), 10)

    def test_skip_docs_and_tail(self):
        epub = build_epub(self.tmp / "a.epub", chapters=3)
        text = extract_epub(epub, skip_docs=3, skip_tail=1)  # drops ch1 and ch3
        self.assertIn("Chapter 2", text)
        self.assertNotIn("Chapter 1", text)
        self.assertNotIn("Chapter 3", text)

    def test_drm_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "DRM"):
            extract_epub(build_epub(self.tmp / "d.epub", drm=True))


class MarkovTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = Path(tempfile.mkdtemp())
        cls.text = extract_epub(build_epub(tmp / "a.epub", chapters=6))

    def test_generates_sentences(self):
        random.seed(0)
        chain = Chain(self.text, state_size=2)
        out = [chain.sentence() for _ in range(20)]
        self.assertGreater(sum(1 for s in out if s), 10)
        for s in filter(None, out):
            self.assertGreaterEqual(len(s.split()), 5)

    def test_start_word(self):
        random.seed(0)
        chain = Chain(self.text, state_size=1)
        s = chain.sentence(start="dragon")
        self.assertTrue(s and s.lower().startswith("dragon"))
        self.assertIsNone(chain.sentence(start="zzzznotaword"))

    def test_overlap_filter_blocks_copies(self):
        random.seed(0)
        chain = Chain(self.text, state_size=4, overlap_run=6)
        runs = chain.seen_runs
        for _ in range(40):
            s = chain.sentence()
            if s:
                words = s.split()
                self.assertFalse(any(hash(tuple(words[i:i + 6])) in runs
                                     for i in range(len(words) - 5)))


class CliTests(unittest.TestCase):
    def test_extract_then_markov(self):
        tmp = Path(tempfile.mkdtemp())
        build_epub(tmp / "a.epub", chapters=4)
        corpus = tmp / "corpus.txt"
        run = lambda *a: subprocess.run([sys.executable, "-m", "bad_fanfic", *a], cwd=ROOT,
                                        capture_output=True, text=True)
        r = run("extract", str(tmp), "-o", str(corpus))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(corpus.exists())
        r = run("markov", str(corpus), "-n", "3", "--seed", "1")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertGreaterEqual(len([l for l in r.stdout.splitlines() if l.strip()]), 3)

    def test_help_lists_commands(self):
        r = subprocess.run([sys.executable, "-m", "bad_fanfic", "--help"], cwd=ROOT,
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 0)
        for cmd in ("extract", "markov", "lstm", "gpt2", "export"):
            self.assertIn(cmd, r.stdout)


if __name__ == "__main__":
    unittest.main()
