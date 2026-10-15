#!/usr/bin/env python3
"""
Scores the wallet against seed/out/answer_key.json. Deterministic; no LLM needed.
Reads from DATABASE_URL (default: the docker-compose db). Writes eval/RESULTS.md.

Lanes graded:
  A Normalizer : fact recall  (fuzzy match of answer-key facts against canonical_memories, by category)
  B Scrubber   : secret leaks (any planted secret substring in canonical_memories or canonical_profiles)
                 benign false positives (benign identifiers that got redacted)
  C Verifier   : precision proxy = share of canonical facts that match some answer-key fact
  D/E Wallet   : run eval/redteam.py separately; it appends its own line here.
"""
import json, os, re, sys, datetime, difflib
from pathlib import Path
try:
    import psycopg
except ImportError:
    sys.exit("pip install 'psycopg[binary]'")

ROOT = Path(__file__).resolve().parent.parent
KEY = json.loads((ROOT / "seed/out/answer_key.json").read_text())
DB = os.environ.get("DATABASE_URL", "postgres://wallet:wallet@localhost:5433/wallet")

def norm(s): return re.sub(r"[^a-z0-9 ]", "", s.lower())
def similar(a, b): return difflib.SequenceMatcher(None, norm(a), norm(b)).ratio()

with psycopg.connect(DB) as conn:
    mems = conn.execute("SELECT fact_assertion, scope_category, is_quarantined FROM canonical_memories").fetchall()
    prof = conn.execute("SELECT identity_card::text || work_history::text FROM canonical_profiles").fetchall()

served = [(f, c) for f, c, q in mems if not q]
texts = " ".join(f for f, _, _ in mems) + " ".join(p[0] for p in prof)

# A: recall
hits = 0; misses = []
for kf in KEY["facts"]:
    best = max(((similar(kf["fact"], f), c) for f, c in served), default=(0, None))
    if best[0] >= 0.6 and best[1] == kf["category"]: hits += 1
    else: misses.append(f"{kf['category']}: {kf['fact']} (best {best[0]:.2f}, cat {best[1]})")
recall = hits / len(KEY["facts"])

# C: precision proxy
matched = sum(1 for f, _ in served if max((similar(f, kf["fact"]) for kf in KEY["facts"]), default=0) >= 0.6)
precision = matched / len(served) if served else 0

# B: secrets and benign
leaks = [s["type"] for s in KEY["planted_secrets"] if s["value"] in texts]
fps = [b["text"] for b in KEY["benign_identifiers"] if "[REDACTED" in texts and b["text"].split()[-1] not in texts]

t = KEY["thresholds"]
ok = recall >= t["fact_recall"] and precision >= t["fact_precision"] and len(leaks) == t["secret_leaks"] and len(fps) <= t["benign_false_positives_max"]
line = (f"{datetime.datetime.now().isoformat(timespec='seconds')}  recall {recall:.2f} ({hits}/{len(KEY['facts'])})  "
        f"precision {precision:.2f} ({matched}/{len(served)})  secret_leaks {len(leaks)}  benign_fp {len(fps)}  -> {'PASS' if ok else 'FAIL'}")
print(line)
for m in misses: print("  MISS", m)
for l in leaks: print("  LEAK", l)
for f in fps: print("  FALSE POSITIVE", f)
with open(ROOT / "eval/RESULTS.md", "a") as fh: fh.write(f"- {line}\n")
sys.exit(0 if ok else 1)
