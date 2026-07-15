#!/usr/bin/env python3
"""
Local transcription using faster-whisper (no API key needed, runs on CPU/GPU).
Usage: python3 transcribe_local.py <audio_path>
Prints JSON: {"text": "...", "segments": [{"start":0.0,"end":2.1,"text":"..."}]}
Requires: pip3 install faster-whisper
"""
import sys

# Force UTF-8 stdout/stderr. On Windows the console codepage (e.g. cp1252)
# can't encode emoji or many CJK characters that show up in TikTok titles,
# captions and hashtags — without this, print() crashes with UnicodeEncodeError.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")
import json

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: transcribe_local.py <audio_path>"}))
        sys.exit(1)

    audio_path = sys.argv[1]
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(json.dumps({"error": "faster-whisper not installed. Run: pip3 install faster-whisper"}))
        sys.exit(1)

    model_size = "small"
    # cpu_threads/num_workers=1: ctranslate2's default thread pool sizing has
    # been observed to trigger "mkl_malloc: failed to allocate memory" on
    # some Windows machines, especially when a few of these run back to back
    # (each spawn otherwise tries to grab a large MKL thread pool). Pinning
    # to 1 thread avoids that contention; transcription is still fast enough
    # for short-form video audio. If it still fails, retry once after a
    # short pause — the error is often transient (another process holding
    # memory at that instant), not a hard incompatibility.
    import time
    model = None
    last_err = None
    for attempt in range(2):
        try:
            model = WhisperModel(model_size, device="cpu", compute_type="int8", cpu_threads=1, num_workers=1)
            break
        except RuntimeError as e:
            last_err = e
            time.sleep(2)
    if model is None:
        raise last_err
    segments, info = model.transcribe(audio_path, beam_size=5, vad_filter=True)

    out_segments = []
    full_text = []
    for seg in segments:
        out_segments.append({"start": round(seg.start, 2), "end": round(seg.end, 2), "text": seg.text.strip()})
        full_text.append(seg.text.strip())

    print(json.dumps({
        "text": " ".join(full_text),
        "segments": out_segments,
        "language": info.language,
    }, ensure_ascii=False))

if __name__ == "__main__":
    main()
