"""Rebuild the matched transcript and recount the review using public records."""
import json
import math
import re
import statistics
from collections import defaultdict
from html import escape
from pathlib import Path

here = Path(__file__).resolve().parent
prior = here.parent / "luna-scenes-2026-11-08"
pairs = [
    (here, "cafe-before", "cafe-listeners-128", "카페 · 128차례 유지"),
    (prior, "station-release-256", "station-rest-256", "관측기지 · 상황 발생 켬"),
    (here, "orchard-before", "orchard-listeners-a", "최소 설정 과수원 · 표본 A"),
    (here, "orchard-before", "orchard-listeners-b", "최소 설정 과수원 · 표본 B"),
    (here, "cafe-natural-before", "cafe-natural-listeners", "카페 · 모두 조용해지면 종료"),
]


def load(folder):
    usage = json.loads((folder / "usage.json").read_text(encoding="utf8"))
    runs = {run["label"]: run for run in usage["runs"]}
    rows = defaultdict(list)
    for line in (folder / "transcript.jsonl").read_text(encoding="utf8").splitlines():
        turn = json.loads(line)
        rows[turn["run"]].append(turn)
    if folder == here:
        ledger = usage["ledger"]
        assert ledger["requests"] == ledger["settled"] == sum(r["requests"] for r in runs.values())
        assert math.isclose(ledger["conservativeUsd"], sum(r["usd"] for r in runs.values()))
        for label, run in runs.items():
            assert run["status"] == "completed" and run["unpriced"] == run["missingUsage"] == 0
            assert len(rows[label]) == run["choices"] + run["events"]
    return runs, rows


def cell(row):
    if row is None:
        return "실행 종료"
    def literal(text):
        return escape(text, quote=False).replace("|", "&#124;").replace("\n", "<br>")
    at = f" · {row['at']:.1f}초" if row["at"] is not None else ""
    lines = [f"**{literal(row['speaker'])}{at}**"]
    if row["speech"]:
        lines.append(literal(row["speech"]))
    if row["action"]:
        lines.append("행동 · " + literal(row["action"]))
    if len(lines) == 1:
        lines.append("대사·행동 문구 없음")
    return "<br>".join(lines)


def style(speech):
    sentences = [s.strip() for s in re.split(r"[.!?？。…]+", speech) if s.strip()]
    return (math.log1p(len(speech)), len(sentences), bool(re.search("[?？]", speech)),
            sum(s.endswith("요") for s in sentences) / max(1, len(sentences)),
            speech.startswith(("네,", "네.", "알겠", "그럼", "그러면")),
            bool(re.search("저는|제가|제게|제 입장", speech)), "겠" in speech)


def voice_hits(spoken):
    training = defaultdict(list)
    for r in spoken:
        if r["turn"] <= 24:
            training[r["speaker"]].append(style(r["speech"]))
    features = [v for rows in training.values() for v in rows]
    scales = [statistics.pstdev(col) or 1 for col in zip(*features)]
    centers = {a: list(map(statistics.mean, zip(*rows))) for a, rows in training.items()}
    hits = 0
    later = [r for r in spoken if r["turn"] > 24]
    for row in later:
        v = style(row["speech"])
        def distance(actor):
            return sum(((x - y) / s) ** 2 for x, y, s in zip(v, centers[actor], scales))
        hits += min(sorted(centers), key=distance) == row["speaker"]
    return hits, len(later)


records = {folder: load(folder) for folder in (here, prior)}
out = ["# 같은 조건의 Luna 대화 원문", "",
       "두 실행의 같은 선택 순번을 나란히 놓았다. 장면이 독립적으로 진행되므로 가상 시각과 화자는 달라질 수 있다. 행동만 한 차례와 아무 말도 하지 않은 차례도 표시했다. [평가와 비용](report.md) · [이번 실행의 대사·세계 관찰](transcript.jsonl) · [개정 전 관측기지의 대사·세계 관찰](../luna-scenes-2026-11-08/transcript.jsonl)"]
for folder, before, after, title in pairs:
    arms = []
    for source, label in ((folder, before), (here, after)):
        runs, data = records[source]
        run = runs[label]
        choices = {r["turn"]: r for r in data[label] if r["kind"] == "speech"}
        assert list(choices) == list(range(1, run["choices"] + 1))
        spoken = [r for r in choices.values() if r["speech"].strip()]
        assert len(spoken) == run["spoken"]
        if label.startswith("orchard"):
            print(label, "style hits / spoken", voice_hits(spoken))
        else:
            station = label.startswith("station")
            tail = [r for r in spoken if r["turn"] >= (193 if station else 97)]
            pattern = r"환풍기|진동|덮개|고정 나사|덜컹" if station else "레몬"
            print(label, "late mentions / spoken", sum(bool(re.search(pattern, r["speech"])) for r in tail), len(tail))
        arms.append((run, choices))
    (a, first), (b, second) = arms
    assert a["specSha256"] == b["specSha256"], title
    out.extend(["", "## " + title, "", f"저장 설정 SHA-256 `{a['specSha256']}`. "
                f"개정 전 {a['choices']}차례·${a['usd']:.5f}, 개정 후 {b['choices']}차례·${b['usd']:.5f}.", "",
                f"| 차례 | 개정 전 · {before} | 개정 후 · {after} |", "|---:|---|---|"])
    for number in range(1, max(len(first), len(second)) + 1):
        out.append(f"| {number} | {cell(first.get(number))} | {cell(second.get(number))} |")
(here / "comparison.md").write_bytes(("\n".join(out) + "\n").encode("utf8"))
