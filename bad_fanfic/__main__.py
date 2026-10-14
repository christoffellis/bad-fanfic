"""Dispatcher so everything runs as `python -m bad_fanfic <command> ...`."""

import importlib
import sys

COMMANDS = {
    "extract": "bad_fanfic.epub_to_text",
    "markov": "bad_fanfic.markov",
    "lstm": "bad_fanfic.lstm",
    "gpt2": "bad_fanfic.gpt2",
    "export": "bad_fanfic.export_onnx",
}

USAGE = """usage: python -m bad_fanfic <command> [args]

commands:
  extract   epubs -> corpus.txt
  markov    Markov-chain generator (no GPU, instant)
  lstm      character-level LSTM  (train | generate)
  gpt2      fine-tune GPT-2       (train | generate)
  export    fine-tuned GPT-2 -> quantized ONNX for the browser

Run a command with -h for its options."""


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] in {"-h", "--help"} or sys.argv[1] not in COMMANDS:
        print(USAGE)
        sys.exit(0 if len(sys.argv) > 1 and sys.argv[1] in {"-h", "--help"} else 1)
    module = importlib.import_module(COMMANDS[sys.argv[1]])
    module.main(sys.argv[2:])


if __name__ == "__main__":
    main()
