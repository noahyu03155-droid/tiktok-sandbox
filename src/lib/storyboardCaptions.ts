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

const MAX_CHARS_PER_LINE = 26;
const MAX_LINES = 3;

function wrapWords(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > MAX_CHARS_PER_LINE && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function wrapCaption(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const lines = wrapWords(clean);
  if (lines.length <= MAX_LINES) return lines.join("\n");
  const truncated = lines.slice(0, MAX_LINES);
  truncated[MAX_LINES - 1] = truncated[MAX_LINES - 1].replace(/.{0,3}$/, "") + "…";
  return truncated.join("\n");
}
