// Word-wraps a shot's script text into a short on-screen caption for the
// storyboard render's burned-in subtitles (ffmpeg drawtext, fed via
// `textfile=` in the render route so caption content never needs escaping
// for the filtergraph — see render/route.ts). Deliberately short: this is a
// caption overlay, not a full-text teleprompter dump, so long shots get
// truncated rather than filling the whole screen.

// Installed by `fonts-noto-cjk` in the Dockerfile — one font file covers
// both Latin and Chinese/Japanese/Korean text, since a shot's label/
// instruction can be edited into either.
export const CAPTION_FONT_FILE = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc";

// Defaults match the original always-on behavior when no reference-video
// style profile is in play. A style profile's captionStyle picks one of
// these presets instead — "punchy" for fast-cut references (short bursts,
// like a viral-style caption), "minimal" for a single short line, or
// "descriptive" (the original default) for a fuller caption.
const CAPTION_PRESETS = {
  descriptive: { maxCharsPerLine: 26, maxLines: 3 },
  punchy: { maxCharsPerLine: 16, maxLines: 2 },
  minimal: { maxCharsPerLine: 20, maxLines: 1 },
} as const;

export type CaptionStylePreset = keyof typeof CAPTION_PRESETS;

function wrapWords(text: string, maxCharsPerLine: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function wrapCaption(text: string, style: CaptionStylePreset = "descriptive"): string {
  const { maxCharsPerLine, maxLines } = CAPTION_PRESETS[style];
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const lines = wrapWords(clean, maxCharsPerLine);
  if (lines.length <= maxLines) return lines.join("\n");
  const truncated = lines.slice(0, maxLines);
  truncated[maxLines - 1] = truncated[maxLines - 1].replace(/.{0,3}$/, "") + "…";
  return truncated.join("\n");
}
