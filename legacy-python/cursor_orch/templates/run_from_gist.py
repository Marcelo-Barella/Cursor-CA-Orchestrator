#!/usr/bin/env python3

import sys


def main() -> None:
    print(
        "run_from_gist.py is retired. Launch the orchestrator from a pinned bootstrap runtime ref instead.",
        file=sys.stderr,
    )
    sys.exit(1)


if __name__ == "__main__":
    main()
