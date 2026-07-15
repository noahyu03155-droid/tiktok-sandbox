#!/usr/bin/env python3
"""
Fetch a TikTok video + metadata by URL using yt-dlp.
Usage: python3 fetch_tiktok.py <tiktok_url> <output_dir> <record_id>
Prints a single JSON object to stdout on success.
Prints {"error": "..."} to stdout and exits 1 on failure.
"""
import sys

# Force UTF-8 stdout/stderr. On Windows the console codepage (e.g. cp1252)
# can't encode emoji or many CJK characters that show up in TikTok titles,
# captions and hashtags — without this, print() crashes with UnicodeEncodeError.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")
import os
import json

def main():
    if len(sys.argv) < 4:
        print(json.dumps({"error": "usage: fetch_tiktok.py <url> <output_dir> <record_id>"}))
        sys.exit(1)

    url, out_dir, record_id = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(out_dir, exist_ok=True)

    try:
        import yt_dlp
    except ImportError:
        print(json.dumps({"error": "yt-dlp not installed. Run: pip3 install -r scripts/requirements.txt"}))
        sys.exit(1)

    video_path = os.path.join(out_dir, f"{record_id}.mp4")
    thumb_path = os.path.join(out_dir, f"{record_id}.jpg")

    ydl_opts = {
        "outtmpl": video_path,
        "format": "mp4/best",
        "writethumbnail": True,
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "noprogress": True,
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
    except Exception as e:
        print(json.dumps({"error": f"yt-dlp failed: {str(e)}"}))
        sys.exit(1)

    # yt-dlp names the thumbnail file after whatever extension/content-type
    # the CDN response implies — usually jpg/webp/png, but for some TikTok
    # CDN responses (no clear image content-type) it falls back to a
    # generic ".image" extension. Rather than keep extending a fixed list
    # every time a new one shows up, just glob for record_id.<anything>
    # and exclude the files we know aren't the thumbnail.
    actual_thumb = None
    skip_exts = {".mp4", ".mp3", ".part", ".ytdl", ".json"}
    for fname in os.listdir(out_dir):
        if not fname.startswith(f"{record_id}."):
            continue
        ext = os.path.splitext(fname)[1].lower()
        if ext in skip_exts:
            continue
        actual_thumb = os.path.join(out_dir, fname)
        break

    result = {
        "id": record_id,
        "source_url": url,
        "webpage_url": info.get("webpage_url"),
        "title": info.get("title") or info.get("description") or "",
        "description": info.get("description") or "",
        "author": info.get("uploader") or info.get("creator") or "",
        "author_id": info.get("uploader_id") or "",
        "create_timestamp": info.get("timestamp"),
        "duration_sec": info.get("duration"),
        "stats": {
            "play_count": info.get("view_count"),
            "digg_count": info.get("like_count"),
            "comment_count": info.get("comment_count"),
            "share_count": info.get("repost_count"),
        },
        "hashtags": [t for t in (info.get("tags") or [])],
        "video_path": video_path if os.path.exists(video_path) else None,
        "thumbnail_path": actual_thumb,
    }

    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0)

if __name__ == "__main__":
    main()
