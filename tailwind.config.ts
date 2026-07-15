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
        // for any leftover reference, but the app now runs a dark theme
        // (see ink/panel/edge below) — the cream color no longer appears
        // as the page bg.
        cream: {
          DEFAULT: "#f3efec",
        },
        // Dark theme surfaces (Daily-Virals-style dashboard look). "ink" is
        // the page background, "panel"/"panel2" are card surfaces (panel2
        // = one step lighter, for nested/hover elements), "edge"/"edge2"
        // are borders (edge2 = one step lighter, for hover states).
        ink: {
          DEFAULT: "#0a0a0b",
        },
        panel: {
          DEFAULT: "#161618",
        },
        // Flat (unnested) keys so classes read as `bg-panel2` / `border-edge2`
        // rather than Tailwind's nested `bg-panel-2` — matches what's
        // actually used across the components.
        panel2: "#1f1f22",
        edge: {
          DEFAULT: "#28282c",
        },
        edge2: "#38383e",
        // Pink used for the wordmark logo only (see Logo.tsx) — the rest of
        // the UI (buttons, active nav, links) still uses `brand` (blue).
        pawpink: {
          400: "#f472b6",
          500: "#ec4899",
          600: "#db2777",
        },
      },
    },
  },
  plugins: [],
};
export default config;
