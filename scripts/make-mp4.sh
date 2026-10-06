#!/usr/bin/env bash
# Turns OUT/raw-<PART>.webm + OUT/segments-<PART>.json (from scripts/record-demo.mjs) into OUT/demo-<PART>.mp4,
# playing the waiting stretches faster. Needs ffmpeg and python3 (e.g. a Debian container).
set -euo pipefail
OUT="${1:-.}"
PART="${2:-AB}"
python3 - "$OUT" "$PART" <<'PY'
import json, subprocess, sys
out, part = sys.argv[1], sys.argv[2]
meta = json.load(open(f"{out}/segments-{part}.json"))
dur, segs = meta["duration"], sorted(meta["segments"], key=lambda s: s["from"])
parts, t = [], 0.0
for s in segs:
    if s["from"] > t: parts.append((t, s["from"], 1))
    parts.append((s["from"], s["to"], s["speed"])); t = s["to"]
if t < dur: parts.append((t, dur, 1))
chains, labels = [], []
for i, (a, b, sp) in enumerate(parts):
    chains.append(f"[0:v]trim=start={a}:end={b},setpts=(PTS-STARTPTS)/{sp},fps=25[v{i}]"); labels.append(f"[v{i}]")
flt = ";".join(chains) + ";" + "".join(labels) + f"concat=n={len(parts)}:v=1:a=0[outv]"
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", f"{out}/raw-{part}.webm", "-filter_complex", flt, "-map", "[outv]",
                "-c:v", "libx264", "-preset", "medium", "-crf", "24", "-pix_fmt", "yuv420p", "-movflags", "+faststart", f"{out}/demo-{part}.mp4"], check=True)
total = sum((b - a) / sp for a, b, sp in parts)
print(f"demo-{part}.mp4: {total:.0f} s (raw {dur:.0f} s)")
PY
