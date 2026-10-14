"""Extract clean plain text from one or more DRM-free epub files.

Pure standard library: an epub is just a zip of XHTML files, so no extra
packages are needed.

Usage:
    python -m bad_fanfic extract books/ -o corpus.txt
    python -m bad_fanfic extract book1.epub book2.epub -o corpus.txt --skip-docs 2

The output is a single UTF-8 text file with one paragraph per line and books
separated by a blank line. Every generator in this repo reads it.
"""

from __future__ import annotations

import argparse
import posixpath
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote

# Spine documents whose file name or id looks like junk are skipped.
JUNK_NAME = re.compile(
    r"(cover|toc|contents|copyright|title|dedicat|acknowledg|about|author|"
    r"also|praise|nav|colophon|imprint|license|newsletter|excerpt|preview)",
    re.I,
)

SMART = {
    "‘": "'", "’": "'", "‚": "'", "‛": "'",
    "“": '"', "”": '"', "„": '"',
    "–": "-", "—": "-", "―": "-",
    "…": "...", " ": " ", "​": "", "﻿": "",
}

BLOCK_TAGS = {"p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote",
              "div", "br", "tr", "section"}
SKIP_TAGS = {"script", "style", "nav", "head"}

# Font obfuscation is fine; anything else in encryption.xml means DRM.
FONT_ALGOS = ("http://www.idpf.org/2008/embedding", "http://ns.adobe.com/pdf/enc#RC")


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in SKIP_TAGS:
            self.skip += 1
        elif tag in BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in SKIP_TAGS:
            self.skip = max(0, self.skip - 1)
        elif tag in BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def html_paragraphs(markup: bytes) -> list[str]:
    parser = _TextExtractor()
    parser.feed(markup.decode("utf-8", errors="replace"))
    lines = (" ".join(line.split()) for line in "".join(parser.parts).split("\n"))
    return [line for line in lines if line]


def normalize(text: str) -> str:
    for src, dst in SMART.items():
        text = text.replace(src, dst)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def check_drm(z: zipfile.ZipFile) -> None:
    if "META-INF/encryption.xml" not in z.namelist():
        return
    root = ET.fromstring(z.read("META-INF/encryption.xml"))
    for el in root.iter():
        if _local(el.tag) == "EncryptionMethod":
            algo = el.get("Algorithm", "")
            if not algo.startswith(FONT_ALGOS):
                raise ValueError("epub is DRM-protected; remove DRM first")


def spine_documents(z: zipfile.ZipFile) -> list[tuple[str, str]]:
    """Return (path-in-zip, manifest-id) for each readable spine document."""
    container = ET.fromstring(z.read("META-INF/container.xml"))
    rootfile = next(el for el in container.iter() if _local(el.tag) == "rootfile")
    opf_path = rootfile.get("full-path")
    base = posixpath.dirname(opf_path)
    opf = ET.fromstring(z.read(opf_path))

    manifest = {}
    spine = []
    for el in opf.iter():
        name = _local(el.tag)
        if name == "item":
            manifest[el.get("id")] = (el.get("href", ""), el.get("media-type", ""))
        elif name == "itemref" and el.get("linear", "yes") != "no":
            spine.append(el.get("idref"))

    docs = []
    for idref in spine:
        href, media = manifest.get(idref, ("", ""))
        if "html" not in media:
            continue
        path = posixpath.normpath(posixpath.join(base, unquote(href.split("#")[0])))
        if path in z.namelist():
            docs.append((path, idref))
    return docs


def extract_epub(path: Path, skip_docs: int = 0, skip_tail: int = 0,
                 min_chars: int = 400, keep_junk: bool = False) -> str:
    with zipfile.ZipFile(path) as z:
        check_drm(z)
        docs = spine_documents(z)
        if skip_tail:
            docs = docs[:-skip_tail]
        docs = docs[skip_docs:]

        chapters = []
        for doc_path, doc_id in docs:
            if not keep_junk and JUNK_NAME.search(f"{posixpath.basename(doc_path)} {doc_id}"):
                continue
            text = "\n".join(html_paragraphs(z.read(doc_path)))
            if len(text) < min_chars and not keep_junk:
                continue  # tiny pages are almost always front/back matter
            chapters.append(text)
    return normalize("\n\n".join(chapters))


def collect(inputs: list[str]) -> list[Path]:
    files: list[Path] = []
    for raw in inputs:
        p = Path(raw)
        if p.is_dir():
            files.extend(sorted(p.rglob("*.epub")))
        elif p.suffix.lower() == ".epub" and p.exists():
            files.append(p)
        else:
            print(f"skipping {p}: not an epub or directory", file=sys.stderr)
    return files


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="bad_fanfic extract", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+", help="epub files and/or folders of epubs")
    ap.add_argument("-o", "--out", default="corpus.txt")
    ap.add_argument("--skip-docs", type=int, default=0,
                    help="drop this many documents from the start of each book")
    ap.add_argument("--skip-tail", type=int, default=0,
                    help="drop this many documents from the end of each book")
    ap.add_argument("--min-chars", type=int, default=400,
                    help="drop documents shorter than this (front/back matter)")
    ap.add_argument("--keep-junk", action="store_true",
                    help="keep cover/toc/copyright-looking documents")
    args = ap.parse_args(argv)

    files = collect(args.inputs)
    if not files:
        sys.exit("no epub files found")

    books = []
    for f in files:
        try:
            text = extract_epub(f, args.skip_docs, args.skip_tail,
                                args.min_chars, args.keep_junk)
        except Exception as exc:  # DRM, malformed zip, missing OPF
            print(f"FAILED {f.name}: {exc}", file=sys.stderr)
            continue
        print(f"{f.name}: {len(text):,} chars")
        if text:
            books.append(text)

    if not books:
        sys.exit("nothing extracted (are the epubs DRM-free?)")
    Path(args.out).write_text("\n\n".join(books) + "\n", encoding="utf-8")
    total = sum(len(b) for b in books)
    print(f"wrote {args.out}: {len(books)} books, {total:,} chars")


if __name__ == "__main__":
    main()
