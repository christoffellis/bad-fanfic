"""Builds tiny synthetic epubs (original text) for tests. Standard library only."""

from __future__ import annotations

import random
import zipfile
from pathlib import Path

CONTAINER = """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"""

SUBJECTS = ["The wizard", "Granny Mabel", "A very tired owl", "The headmaster",
            "Little Pip", "The dragon", "Captain Dusk", "The librarian"]
VERBS = ["quietly ate", "angrily juggled", "forgot about", "politely argued with",
         "secretly adored", "tripped over", "sang to", "bargained with"]
OBJECTS = ["a haunted teapot", "the village goat", "seventeen soggy biscuits",
           "an enormous cabbage", "the moon", "a suspicious wardrobe",
           "the tax collector", "a pile of ancient socks"]
TAILS = ["before breakfast", "during the thunderstorm", "without anyone noticing",
         "for reasons nobody understood", "while the bells rang", "near the old bridge"]


def chapter_text(rng: random.Random, paragraphs: int = 12) -> list[str]:
    paras = []
    for _ in range(paragraphs):
        sentences = []
        for _ in range(rng.randint(3, 6)):
            sentences.append(
                f"{rng.choice(SUBJECTS)} {rng.choice(VERBS)} {rng.choice(OBJECTS)} "
                f"{rng.choice(TAILS)}.")
        paras.append(" ".join(sentences))
    return paras


def xhtml(title: str, paras: list[str]) -> str:
    body = "\n".join(f"<p>{p}</p>" for p in paras)
    return (f'<?xml version="1.0" encoding="utf-8"?>'
            f'<html xmlns="http://www.w3.org/1999/xhtml"><head><title>{title}</title>'
            f"<style>p {{ margin: 0 }}</style></head><body><h1>{title}</h1>\n{body}\n</body></html>")


def build_epub(path: Path, chapters: int = 3, drm: bool = False, seed: int = 1) -> Path:
    rng = random.Random(seed)
    files = {
        "cover.xhtml": xhtml("Cover", ["Nobody Reads This"]),
        "copyright.xhtml": xhtml("Copyright", ["All rights reserved by nobody."]),
    }
    for i in range(1, chapters + 1):
        paras = chapter_text(rng)
        paras[0] = "“It’s fine,” said everyone — loudly… " + paras[0]
        files[f"ch{i}.xhtml"] = xhtml(f"Chapter {i}", paras)

    order = ["cover.xhtml", "copyright.xhtml"] + [f"ch{i}.xhtml" for i in range(1, chapters + 1)]
    manifest = "\n".join(
        f'<item id="{Path(n).stem}" href="{n}" media-type="application/xhtml+xml"/>' for n in order)
    spine = "\n".join(f'<itemref idref="{Path(n).stem}"/>' for n in order)
    opf = (f'<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">'
           f"<metadata/><manifest>{manifest}</manifest><spine>{spine}</spine></package>")

    with zipfile.ZipFile(path, "w") as z:
        z.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", CONTAINER)
        z.writestr("OEBPS/content.opf", opf)
        for name, content in files.items():
            z.writestr(f"OEBPS/{name}", content)
        if drm:
            z.writestr(
                "META-INF/encryption.xml",
                '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
                '<EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#">'
                '<EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>'
                "</EncryptedData></encryption>")
    return path


if __name__ == "__main__":  # python tests/epub_fixture.py out.epub [chapters] [drm]
    import sys

    build_epub(Path(sys.argv[1]), int(sys.argv[2]) if len(sys.argv) > 2 else 3,
               drm=len(sys.argv) > 3 and sys.argv[3] == "drm")
