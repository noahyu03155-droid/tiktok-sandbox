#!/usr/bin/env python3
"""
Metadata-only scan of a TikTok creator's video history via yt-dlp.

Deliberately does NOT download video/audio files — a tracked creator can
have hundreds of videos, and downloading + transcribing all of them up
front doesn't scale. This just pulls per-video metadata (views/likes/
comments/shares/title/hashtags/thumbnail URL) so the Creator Tracker can
render its list/stats/product-grouping views. A specific video only gets
the full fetch_tiktok.py + transcribe treatment once someone actually
clicks into it for the AI breakdown (see src/lib/creatorPipeline.ts).

Usage: python3 list_creator_videos.py <profile_url_or_@handle> [max_count]
Prints a single JSON object to stdout on success.
Prints {"error": "..."} to stdout and exits 1 on failure.
"""
import sys

# Force UTF-8 stdout/stderr — see fetch_tiktok.py for why (Windows console
# codepages choke on emoji/CJK that show up in TikTok titles/hashtags).
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")
import json


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: list_creator_videos.py <profile_url_or_@handle> [max_count]"}))
        sys.exit(1)

    raw = sys.argv[1].strip()
    try:
        max_count = int(sys.argv[2]) if len(sys.argv) > 2 else 150
    except ValueError:
        max_count = 150

    if raw.startswith("http"):
        profile_url = raw
    else:
        profile_url = f"https://www.tiktok.com/@{raw.lstrip('@')}"

    try:
        import yt_dlp
    except ImportError:
        print(json.dumps({"error": "yt-dlp not installed. Run: pip3 install -r scripts/requirements.txt"}))
        sys.exit(1)

    ydl_opts = {
        # extract_flat=False so each entry actually resolves to real stats
        # (views/likes/comments/shares) rather than just a bare id/url —
        # flat extraction is faster but nearly empty of the numbers we need.
        "extract_flat": False,
        "skip_download": True,
        "quiet": True,
        "no_warnings": True,
        "ignoreerrors": True,
        "playlistend": max_count,
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(profile_url, download=False)
    except Exception as e:
        print(json.dumps({"error": f"yt-dlp failed: {str(e)}"}))
        sys.exit(1)

    if not info:
        print(json.dumps({"error": "Could not read this profile — check the handle/link and that the account is public."}))
        sys.exit(1)

    entries = [e for e in (info.get("entries") or []) if e]

    # Creator-level fields come off the playlist/channel-level info dict
    # (more reliable than any single video entry); fall back to the first
    # entry's uploader fields if the channel-level ones are missing.
    name = info.get("uploader") or info.get("channel") or info.get("title")
    handle_out = info.get("uploader_id") or info.get("channel_id")
    followers = info.get("channel_follower_count")
    avatar_url = None
    thumbs = info.get("thumbnails") or []
    if thumbs:
        avatar_url = thumbs[-1].get("url")

    videos = []
    for e in entries:
        vid = e.get("id")
        if not vid:
            continue
        if name is None:
            name = e.get("uploader") or e.get("creator")
        if handle_out is None:
            handle_out = e.get("uploader_id")
        if followers is None:
            followers = e.get("channel_follower_count")

        thumb = e.get("thumbnail")
        if not thumb:
            entry_thumbs = e.get("thumbnails") or []
            if entry_thumbs:
                thumb = entry_thumbs[-1].get("url")

        videos.append({
            "id": vid,
            "url": e.get("webpage_url") or f"https://www.tiktok.com/@{e.get('uploader_id') or handle_out or ''}/video/{vid}",
            "title": e.get("title") or e.get("description") or "",
            "description": e.get("description") or "",
            "hashtags": [t for t in (e.get("tags") or [])],
            "thumbnail_url": thumb,
            "create_timestamp": e.get("timestamp"),
            "stats": {
                "play_count": e.get("view_count"),
                "digg_count": e.get("like_count"),
                "comment_count": e.get("comment_count"),
                "share_count": e.get("repost_count"),
            },
        })

    result = {
        "handle": (handle_out or raw).lstrip("@"),
        "name": name,
        "avatar_url": avatar_url,
        "followers": followers,
        "videos": videos,
    }
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0)


if __name__ == "__main__":
    main()
