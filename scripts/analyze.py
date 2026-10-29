"""Aggregate NPC Lab invocation exports using only the Python standard library."""
import argparse
import csv
import math
from collections import defaultdict
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="NPC Lab 호출 CSV를 조건별로 집계합니다.")
    parser.add_argument("folders", nargs="+", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    groups = defaultdict(list)
    seen = set()
    for path in args.folders:
        source = path / "invocations.csv" if path.is_dir() else path
        with source.open(encoding="utf-8-sig", newline="") as stream:
            for row in csv.DictReader(stream):
                if row["id"] in seen:
                    continue
                seen.add(row["id"])
                import json
                metadata = json.loads(row.get("metadata") or "{}")
                key = (metadata.get("adapter", "unknown"), row["model"], row["effort"], row["deliveryMode"], row["memoryMode"], row["kind"])
                groups[key].append(row)
    results = []
    for key, rows in sorted(groups.items()):
        durations = sorted(float(row["durationMs"]) for row in rows if row["status"] == "completed" and row["durationMs"])
        known_tokens = [int(row["totalTokens"]) for row in rows if row["totalTokens"]]
        failed = sum(row["status"] in ("failed", "cancelled", "uncertain") for row in rows)
        results.append(dict(zip(("adapter", "model", "effort", "deliveryMode", "memoryMode", "kind"), key),
            runs=len({row["runId"] for row in rows}), calls=len(rows), totalTokens=sum(known_tokens) if known_tokens else "",
            missingUsage=sum(not row["totalTokens"] and row["status"] not in ("queued", "running") for row in rows),
            pendingCalls=sum(row["status"] in ("queued", "running") for row in rows), failed=failed, failureRate=failed / len(rows),
            medianMs=durations[max(0, math.ceil(len(durations) * .5) - 1)] if durations else "",
            p95Ms=durations[max(0, math.ceil(len(durations) * .95) - 1)] if durations else ""))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    columns = list(results[0]) if results else ["adapter", "model", "effort", "deliveryMode", "memoryMode", "kind", "calls", "totalTokens"]
    with args.out.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=columns)
        writer.writeheader()
        writer.writerows(results)
    print(f"{len(seen)} calls / {len(results)} groups -> {args.out}")


if __name__ == "__main__":
    main()
