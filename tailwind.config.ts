import type { Config } from "tailwindcss";
const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        // Brand blue, matching The Pawmart's logo.
        brand: {
          50: "#eaf7fd",
          100: "#d3eefb",
          400: "#5cc4ee",
          500: "#2fb6ea",
          600: "#1f9bd0",
          700: "#1a7fac",
        },
        // Page background — The Pawmart's cream brand color. Kept around
        // for any leftover reference; superseded by ink/panel below.
        cream: {
          DEFAULT: "#f3efec",
        },
        // Phase 19: flipped from the old dark (near-black) theme to a light,
        // bold-type theme (white page bg, black headline text, thin light
        // borders) matching the COTORX rebrand reference. Same semantic
        // token NAMES as before (ink/panel/panel2/edge/edge2) so most
        // components didn't need per-file edits — only the VALUES changed
        // here. "ink" is the page background, "panel"/"panel2" are card
        // surfaces (panel2 = one step darker, for nested/hover elements),
        // "edge"/"edge2" are borders (edge2 = one step darker, for hover
        // states).
        ink: {
          DEFAULT: "#ffffff",
        },
        panel: {
          DEFAULT: "#f7f7f8",
        },
        // Flat (unnested) keys so classes read as `bg-panel2` / `border-edge2`
        // rather than Tailwind's nested `bg-panel-2` — matches what's
        // actually used across the components.
        panel2: "#eeeef0",
        edge: {
          DEFAULT: "#e4e4e7",
        },
        edge2: "#d4d4d8",
        // Retired with the old pink "PAWmart" wordmark (see Logo.tsx, now
        // COTORX) — kept defined in case anything still references it.
        pawpink: {
          400: "#f472b6",
          500: "#ec4899",
          600: "#db2777",
        },
      },
      // Seamless horizontal scroll for the register page's "showcase" strip
      // of real analyzed-video thumbnails (RegisterLanding.tsx) — the strip
      // renders its thumbnail list twice back-to-back, then this animation
      // slides the whole doubled-width row left by exactly half its width,
      // so the loop point is invisible.
      keyframes: {
        marquee: {
          "0%": { transform: "translateX(0)" },
          "100%": { transform: "translateX(-50%)" },
        },
      },
      animation: {
        marquee: "marquee 32s linear infinite",
      },
    },
  },
  plugins: [],
};
export default config;
