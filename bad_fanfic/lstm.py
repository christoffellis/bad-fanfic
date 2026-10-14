"""Character-level LSTM in PyTorch: the 2015 char-rnn route.

Usage:
    python -m bad_fanfic lstm train corpus.txt --steps 3000
    python -m bad_fanfic lstm generate --prompt "The Ministry" --length 600 --temperature 0.8

Small and undertrained is the point: it learns spelling and formatting long
before it learns meaning, which is where the funny comes from.
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F

from bad_fanfic import output


class CharLSTM(nn.Module):
    def __init__(self, vocab: int, hidden: int, layers: int, dropout: float):
        super().__init__()
        self.emb = nn.Embedding(vocab, hidden)
        self.lstm = nn.LSTM(hidden, hidden, layers, batch_first=True,
                            dropout=dropout if layers > 1 else 0.0)
        self.head = nn.Linear(hidden, vocab)

    def forward(self, x, state=None):
        out, state = self.lstm(self.emb(x), state)
        return self.head(out), state


def pick_device(name: str) -> torch.device:
    if name != "auto":
        return torch.device(name)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def train(args) -> None:
    device = pick_device(args.device)
    text = Path(args.corpus).read_text(encoding="utf-8")
    chars = sorted(set(text))
    stoi = {c: i for i, c in enumerate(chars)}
    data = torch.tensor([stoi[c] for c in text], dtype=torch.long)
    if len(data) <= args.seq_len + 1:
        raise SystemExit("corpus is shorter than --seq-len")
    split = int(len(data) * 0.95)
    train_data, val_data = data[:split], data[split:]
    print(f"{len(text):,} chars, vocab {len(chars)}, device {device}")

    model = CharLSTM(len(chars), args.hidden, args.layers, args.dropout).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr)
    print(f"{sum(p.numel() for p in model.parameters()):,} parameters")

    def batch(src):
        ix = torch.randint(0, len(src) - args.seq_len - 1, (args.batch,))
        x = torch.stack([src[i:i + args.seq_len] for i in ix])
        y = torch.stack([src[i + 1:i + args.seq_len + 1] for i in ix])
        return x.to(device), y.to(device)

    def loss_on(src, n=10):
        model.eval()
        total = 0.0
        with torch.no_grad():
            for _ in range(n):
                x, y = batch(src)
                logits, _ = model(x)
                total += F.cross_entropy(logits.reshape(-1, len(chars)), y.reshape(-1)).item()
        model.train()
        return total / n

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    def save():
        torch.save({"model": model.state_dict(), "chars": chars,
                    "hidden": args.hidden, "layers": args.layers,
                    "dropout": args.dropout}, out)

    start = time.time()
    for step in range(1, args.steps + 1):
        x, y = batch(train_data)
        logits, _ = model(x)
        loss = F.cross_entropy(logits.reshape(-1, len(chars)), y.reshape(-1))
        opt.zero_grad(set_to_none=True)
        loss.backward()
        nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        if step % args.log_every == 0 or step == args.steps:
            print(f"step {step}/{args.steps}  train {loss.item():.3f}  "
                  f"val {loss_on(val_data):.3f}  {time.time() - start:.0f}s")
        if step % args.sample_every == 0:
            print("--- sample ---")
            print(sample(model, chars, device, "\n", 300, 0.9))
            print("--------------")
            save()
    save()
    print(f"saved {out}")


@torch.no_grad()
def sample(model, chars, device, prompt: str, length: int, temperature: float,
           top_k: int = 0) -> str:
    stoi = {c: i for i, c in enumerate(chars)}
    model.eval()
    prompt = "".join(c for c in prompt if c in stoi) or chars[0]
    x = torch.tensor([[stoi[c] for c in prompt]], device=device)
    logits, state = model(x)
    out = list(prompt)
    for _ in range(length):
        probs = logits[0, -1] / max(temperature, 1e-4)
        if top_k:
            v, _ = torch.topk(probs, min(top_k, probs.numel()))
            probs[probs < v[-1]] = float("-inf")
        nxt = torch.multinomial(F.softmax(probs, dim=-1), 1)
        out.append(chars[nxt.item()])
        logits, state = model(nxt.view(1, 1), state)
    model.train()
    return "".join(out)


def generate(args) -> None:
    device = pick_device(args.device)
    ckpt = torch.load(args.model, map_location=device)
    chars = ckpt["chars"]
    model = CharLSTM(len(chars), ckpt["hidden"], ckpt["layers"], ckpt["dropout"]).to(device)
    model.load_state_dict(ckpt["model"])
    if args.seed is not None:
        torch.manual_seed(args.seed)
    texts = []
    for i in range(args.count):
        texts.append(sample(model, chars, device, args.prompt, args.length,
                            args.temperature, args.top_k))
        print(texts[-1])
        if i < args.count - 1:
            print("\n" + "=" * 40 + "\n")
    output.save("lstm", texts, args)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="bad_fanfic lstm", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    t = sub.add_parser("train")
    t.add_argument("corpus")
    t.add_argument("--out", default="models/lstm.pt")
    t.add_argument("--hidden", type=int, default=256)
    t.add_argument("--layers", type=int, default=2)
    t.add_argument("--dropout", type=float, default=0.2)
    t.add_argument("--seq-len", type=int, default=128)
    t.add_argument("--batch", type=int, default=64)
    t.add_argument("--steps", type=int, default=3000)
    t.add_argument("--lr", type=float, default=2e-3)
    t.add_argument("--log-every", type=int, default=100)
    t.add_argument("--sample-every", type=int, default=500)
    t.add_argument("--device", default="auto")
    t.set_defaults(fn=train)

    g = sub.add_parser("generate")
    g.add_argument("--model", default="models/lstm.pt")
    g.add_argument("--prompt", default="\n")
    g.add_argument("--length", type=int, default=500)
    g.add_argument("--temperature", type=float, default=0.8)
    g.add_argument("--top-k", type=int, default=0)
    g.add_argument("--count", type=int, default=1)
    g.add_argument("--seed", type=int)
    g.add_argument("--device", default="auto")
    output.add_args(g)
    g.set_defaults(fn=generate)

    args = ap.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
