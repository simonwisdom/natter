"""One JSON line per turn, so 'it said it worked' can be checked against what ran."""

import json
import time
from pathlib import Path


class TraceLog:
    def __init__(self, directory: Path):
        self.directory = directory
        self.directory.mkdir(parents=True, exist_ok=True)

    def write(self, record: dict) -> None:
        path = self.directory / time.strftime("%Y-%m-%d.jsonl")
        with path.open("a") as f:
            f.write(json.dumps(record, default=str) + "\n")
