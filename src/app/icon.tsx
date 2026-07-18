import { ImageResponse } from "next/og";

// Next.js App Router convention: a file literally named icon.tsx directly
// under src/app/ is auto-detected and served as the site favicon (Next
// injects the right <link rel="icon"> tags itself — nothing to wire up in
// layout.tsx). Reuses the same rounded-square + play-triangle mark as
// Logo.tsx (see that file's Phase 47 comment), built with plain div/CSS
// shapes rather than an <svg> — ImageResponse renders through Satori, which
// has much more reliable support for CSS borders/shapes than for arbitrary
// inline SVG.
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#ffffff",
        }}
      >
        <div
          style={{
            width: 26,
            height: 26,
            borderRadius: 8,
            border: "3px solid #18181b",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              width: 0,
              height: 0,
              marginLeft: 2,
              borderTop: "6px solid transparent",
              borderBottom: "6px solid transparent",
              borderLeft: "9px solid #18181b",
            }}
          />
        </div>
      </div>
    ),
    { ...size }
  );
}
