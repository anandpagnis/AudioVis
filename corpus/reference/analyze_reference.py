#!/usr/bin/env python3
"""
Optional: ground-truth tempo + section boundaries for the calibration corpus.

Writes corpus/refs/<id>.json (gitignored) which the TS harness
(scripts/calibrate/harness.calib.ts) reads as the octave-error oracle. Without
these files the harness falls back to a self-consistency flip count.

Usage:
    pip install -r corpus/reference/requirements.txt
    python corpus/reference/analyze_reference.py [--limit N]

Nothing in `npm run check` or `npm run calibrate` needs this to run — it is a
separate, offline pass, same spirit as scripts/convert-essentia-models.md.
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS = os.path.dirname(HERE)
AUDIO_DIR = os.path.join(CORPUS, "audio")
REFS_DIR = os.path.join(CORPUS, "refs")
TESTFOLDER = os.path.join(os.path.dirname(CORPUS), "testfolder")


def analyze(path):
    import librosa
    import numpy as np

    y, sr = librosa.load(path, sr=None, mono=True)

    # Tempo: prefer madmom's DBN tracker (octave-robust); fall back to librosa.
    bpm = None
    try:
        from madmom.features.tempo import TempoEstimationProcessor
        from madmom.features.beats import RNNBeatProcessor

        act = RNNBeatProcessor()(path)
        tempi = TempoEstimationProcessor(fps=100)(act)
        if len(tempi):
            bpm = float(tempi[0][0])
    except Exception as e:  # noqa: BLE001 - madmom is optional
        print(f"  madmom unavailable ({e}); using librosa", file=sys.stderr)

    if bpm is None:
        tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        bpm = float(np.atleast_1d(tempo)[0])

    # Section boundaries via spectral-clustering laplacian segmentation.
    sections = []
    try:
        bounds = librosa.segment.agglomerative(
            librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13), 8
        )
        times = librosa.frames_to_time(bounds, sr=sr)
        sections = [round(float(t), 2) for t in times]
    except Exception as e:  # noqa: BLE001
        print(f"  segmentation failed ({e})", file=sys.stderr)

    return {"bpm": round(bpm, 2), "durationSec": round(len(y) / sr, 1), "sectionSec": sections}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=10**9)
    args = ap.parse_args()

    os.makedirs(REFS_DIR, exist_ok=True)
    dirs = [d for d in (AUDIO_DIR, TESTFOLDER) if os.path.isdir(d)]
    files = []
    for d in dirs:
        for name in sorted(os.listdir(d)):
            if name.endswith(".mp3"):
                files.append((name[:-4], os.path.join(d, name)))
    files = files[: args.limit]
    if not files:
        print("No audio in corpus/audio/ or testfolder/. Fetch it first.", file=sys.stderr)
        sys.exit(1)

    for i, (track_id, path) in enumerate(files, 1):
        out = os.path.join(REFS_DIR, f"{track_id}.json")
        if os.path.exists(out):
            print(f"skip {track_id} (present)")
            continue
        print(f"[{i}/{len(files)}] {track_id}")
        try:
            ref = analyze(path)
            with open(out, "w") as fh:
                json.dump(ref, fh, indent=2)
        except Exception as e:  # noqa: BLE001
            print(f"  FAIL {track_id}: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
