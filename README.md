# Bad Fanfic

Train terrible text generators on your own ebooks. It's the "AI wrote a new chapter" joke from the mid-2010s, with the same three ingredients: a Markov chain, a tiny character-level LSTM, and a lightly fine-tuned GPT-2.

**Try it in the browser:** https://christoffellis.github.io/bad-fanfic/ (drop in an epub, then pick each next word from a predictive keyboard, Botnik style. Your books never leave your machine.)

## What's in here

| Route | What it is | Needs | Vibe |
|---|---|---|---|
| `markov` | Word-level Markov chain | Python only, no packages | Botnik's Harry Potter chapter |
| `lstm` | Character-level LSTM (PyTorch) | `torch` | char-rnn, 2015 |
| `gpt2` | Fine-tune GPT-2 / DistilGPT-2 | `torch`, `transformers` | Confidently wrong fanfic |
| `docs/` | Browser demo (GitHub Pages) | nothing | Predictive keyboard |

## Quick start (Markov, 1 minute)

```bash
git clone https://github.com/christoffellis/bad-fanfic
cd bad-fanfic

# 1. Put DRM-free epubs in books/ (this folder is git-ignored)
python -m bad_fanfic extract books/ -o corpus.txt

# 2. Generate
python -m bad_fanfic markov corpus.txt -n 10
python -m bad_fanfic markov corpus.txt -n 5 --paragraph 4 --state-size 1
```

`--state-size 1` is chaos, `2` is the sweet spot, `3` is coherent (and starts copying). Sentences that repeat 12+ words in a row from the books are rejected by default.

Every `markov`, `lstm generate` and `gpt2 generate` run also saves what it printed to `output/<generator>-<timestamp>.txt` (git-ignored). Use `--out-dir` to pick another folder or `--no-save` to skip it.

## Neural routes

```bash
pip install -r requirements-neural.txt

# character-level LSTM: tiny and fast, even on CPU
python -m bad_fanfic lstm train corpus.txt --steps 3000
python -m bad_fanfic lstm generate --prompt "The " --length 600 --temperature 0.8

# fine-tune GPT-2: use a GPU (or the Colab notebook below)
python -m bad_fanfic gpt2 train corpus.txt --steps 400
python -m bad_fanfic gpt2 generate --prompt "Chapter One" --temperature 1.0
```

No GPU? Open [`notebooks/bad_fanfic_colab.ipynb`](notebooks/bad_fanfic_colab.ipynb) in Google Colab.

Tips for the funny: keep the dataset small, stop training early (checkpoints are saved every 100 steps, and earlier ones are wilder), and raise the temperature.

## Browser demo

The page in [`docs/`](docs) is plain HTML and JavaScript, so GitHub Pages serves it as is. In **Settings > Pages**, set the source to the `main` branch and the `/docs` folder.

- **Source** picks the word chain: the prebuilt models in `docs/models/`, the built-in sample, or your own epubs, which it reads locally with no libraries.
- The keyboard shows the likeliest next words first (press `1`–`9` to pick), then wildcards with dashed borders. Words you pick are highlighted and auto-written words aren't, so you can see where the human ended and the machine began.

### Shipping a Markov model with the site

```bash
python -m bad_fanfic markov corpus.txt --export docs/models/my-books.json --name "My Books"
```

This writes the model and adds it to `docs/models/index.json`, which fills the site's source picker. Commit both files and GitHub Pages serves them. By default the export keeps at most 2 words of context and drops every word transition seen fewer than 3 times (`--max-order`, `--min-count`). That keeps the file small and stops the chain replaying the books: in 2,000 generated sentences, no 8-word stretch matched the source, against 2.2% for an unpruned export. Raising `--max-order` to 3 brings copying back up.
- **Neural mode** loads a model from Hugging Face with [Transformers.js](https://github.com/huggingface/transformers.js). The default is `Xenova/distilgpt2`. To use your own fine-tune, append `?model=YOUR_USER/your-model` to the page URL.

### Hosting your own model on Hugging Face

```bash
pip install "optimum[onnxruntime]" huggingface_hub
python -m bad_fanfic gpt2 train corpus.txt --base distilgpt2 --steps 400
python -m bad_fanfic export models/gpt2/final -o export/my-bad-fanfic   # quantized ONNX
huggingface-cli login
huggingface-cli upload YOUR_USER/my-bad-fanfic export/my-bad-fanfic .
```

DistilGPT-2 quantized is a much lighter download than GPT-2. Model repos need to be public for visitors to load them.

## Don't publish models trained on books you don't own the rights to

A fine-tuned model can reproduce passages from its training data, so a published model trained on a copyrighted book is close to publishing the book. This repo's `.gitignore` excludes epubs, corpora and model files, except the pruned Markov models in `docs/models/`. A pruned chain is still derived from the books, so publishing one is your call. For anything public, train on public-domain text (Project Gutenberg) or your own writing.

## Tests

```bash
python -m unittest discover -s tests   # extractor + Markov (standard library only)
node --test tests/web.test.mjs         # browser epub reader + chain (needs Python for fixtures)
```

## Status

The extractor, Markov generator and browser logic are covered by tests. The `lstm`, `gpt2` and `export` commands, and the browser UI and neural mode, haven't been run end to end yet, so expect to fix a rough edge or two and open an issue.

## License

MIT
