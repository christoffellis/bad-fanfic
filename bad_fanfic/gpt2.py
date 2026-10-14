"""Fine-tune a small GPT-2 on your corpus, then generate from it.

Usage:
    python -m bad_fanfic gpt2 train corpus.txt --steps 400
    python -m bad_fanfic gpt2 generate --prompt "Chapter One" --temperature 1.0

Stop early! A few hundred steps gives 'confidently wrong fanfic'. Train for
long and it starts reciting the books word for word, which is both boring and
a copyright problem. Checkpoints are written every --save-every steps so you
can pick the funniest one.
"""

from __future__ import annotations

import argparse
import random
import time
from pathlib import Path

import torch

from bad_fanfic import output


def pick_device(name: str) -> torch.device:
    if name != "auto":
        return torch.device(name)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def train(args) -> None:
    from transformers import AutoModelForCausalLM, AutoTokenizer

    device = pick_device(args.device)
    tok = AutoTokenizer.from_pretrained(args.base)
    model = AutoModelForCausalLM.from_pretrained(args.base).to(device)

    text = Path(args.corpus).read_text(encoding="utf-8")
    ids = tok(text, return_tensors="pt", truncation=False).input_ids[0]
    block = args.block_size
    n_blocks = len(ids) // block
    if n_blocks < 2:
        raise SystemExit("corpus too small for this --block-size")
    blocks = ids[: n_blocks * block].view(n_blocks, block)
    print(f"{len(ids):,} tokens -> {n_blocks} blocks of {block}; device {device}")

    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    use_amp = device.type == "cuda"
    scaler = torch.amp.GradScaler("cuda", enabled=use_amp)
    model.train()
    start = time.time()
    out = Path(args.out)

    def save(tag: str) -> None:
        target = out / tag
        target.mkdir(parents=True, exist_ok=True)
        model.save_pretrained(target)
        tok.save_pretrained(target)
        print(f"saved {target}")

    for step in range(1, args.steps + 1):
        opt.zero_grad(set_to_none=True)
        loss_val = 0.0
        for _ in range(args.grad_accum):
            idx = random.sample(range(n_blocks), min(args.batch, n_blocks))
            x = blocks[idx].to(device)
            with torch.autocast(device.type, enabled=use_amp):
                loss = model(x, labels=x).loss / args.grad_accum
            scaler.scale(loss).backward()
            loss_val += loss.item()
        scaler.unscale_(opt)
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        scaler.step(opt)
        scaler.update()
        if step % args.log_every == 0 or step == args.steps:
            print(f"step {step}/{args.steps}  loss {loss_val:.3f}  {time.time() - start:.0f}s")
        if step % args.save_every == 0 and step != args.steps:
            save(f"step-{step}")
    save("final")


def generate(args) -> None:
    from transformers import AutoModelForCausalLM, AutoTokenizer

    device = pick_device(args.device)
    tok = AutoTokenizer.from_pretrained(args.model)
    model = AutoModelForCausalLM.from_pretrained(args.model).to(device).eval()
    if args.seed is not None:
        torch.manual_seed(args.seed)
    prompt = tok(args.prompt, return_tensors="pt").to(device)
    texts = []
    for i in range(args.count):
        with torch.no_grad():
            out = model.generate(
                **prompt,
                max_new_tokens=args.length,
                do_sample=True,
                temperature=args.temperature,
                top_p=args.top_p,
                repetition_penalty=args.repetition_penalty,
                pad_token_id=tok.eos_token_id,
            )
        texts.append(tok.decode(out[0], skip_special_tokens=True))
        print(texts[-1])
        if i < args.count - 1:
            print("\n" + "=" * 40 + "\n")
    output.save("gpt2", texts, args)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="bad_fanfic gpt2", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    t = sub.add_parser("train")
    t.add_argument("corpus")
    t.add_argument("--base", default="gpt2",
                   help="gpt2 (124M) or distilgpt2 (82M, smaller download in the browser)")
    t.add_argument("--out", default="models/gpt2")
    t.add_argument("--steps", type=int, default=400)
    t.add_argument("--batch", type=int, default=4)
    t.add_argument("--grad-accum", type=int, default=4)
    t.add_argument("--block-size", type=int, default=256)
    t.add_argument("--lr", type=float, default=5e-5)
    t.add_argument("--log-every", type=int, default=20)
    t.add_argument("--save-every", type=int, default=100)
    t.add_argument("--device", default="auto")
    t.set_defaults(fn=train)

    g = sub.add_parser("generate")
    g.add_argument("--model", default="models/gpt2/final")
    g.add_argument("--prompt", default="Chapter One\n\n")
    g.add_argument("--length", type=int, default=200)
    g.add_argument("--temperature", type=float, default=1.0)
    g.add_argument("--top-p", type=float, default=0.95)
    g.add_argument("--repetition-penalty", type=float, default=1.1)
    g.add_argument("--count", type=int, default=1)
    g.add_argument("--seed", type=int)
    g.add_argument("--device", default="auto")
    output.add_args(g)
    g.set_defaults(fn=generate)

    args = ap.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
