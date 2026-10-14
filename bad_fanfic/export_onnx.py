"""Export a fine-tuned GPT-2 checkpoint to quantized ONNX for Transformers.js.

Usage:
    pip install "optimum[onnxruntime]"
    python -m bad_fanfic export models/gpt2/final -o export/my-bad-fanfic

Then upload the output folder to a Hugging Face model repo:
    pip install -U huggingface_hub
    huggingface-cli login
    huggingface-cli upload YOUR_USER/my-bad-fanfic export/my-bad-fanfic .

Only publish a model trained on text you have the right to redistribute
(e.g. public-domain books). Models trained on copyrighted books can
regurgitate them.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="bad_fanfic export", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("checkpoint", help="folder from `gpt2 train` (e.g. models/gpt2/final)")
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--no-quantize", action="store_true",
                    help="keep fp32 weights (about 4x larger download)")
    args = ap.parse_args(argv)

    out = Path(args.out)
    onnx_dir = out / "onnx"
    out.mkdir(parents=True, exist_ok=True)

    # 1. export to ONNX (text-generation-with-past gives fast incremental decoding)
    subprocess.run(
        [sys.executable, "-m", "optimum.exporters.onnx",
         "--model", args.checkpoint, "--task", "text-generation-with-past",
         str(out / "_raw")],
        check=True)

    onnx_dir.mkdir(exist_ok=True)
    raw = out / "_raw"
    if args.no_quantize:
        shutil.copy(raw / "decoder_model_merged.onnx", onnx_dir / "model.onnx")
    else:
        from onnxruntime.quantization import QuantType, quantize_dynamic

        quantize_dynamic(str(raw / "decoder_model_merged.onnx"),
                         str(onnx_dir / "model_quantized.onnx"),
                         weight_type=QuantType.QUInt8)

    # 2. tokenizer + config files Transformers.js looks for next to onnx/
    for name in ["config.json", "generation_config.json", "tokenizer.json",
                 "tokenizer_config.json", "vocab.json", "merges.txt",
                 "special_tokens_map.json"]:
        src = raw / name
        if src.exists():
            shutil.copy(src, out / name)
    shutil.rmtree(raw)
    print(f"done: {out}")
    for f in sorted(out.rglob("*")):
        if f.is_file():
            print(f"  {f.relative_to(out)}  {f.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
