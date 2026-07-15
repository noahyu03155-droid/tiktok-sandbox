// Text-based recreation of The Pawmart's pink bubble-letter wordmark. This
// is still a CSS approximation, not the real artwork — the logo image you
// shared in chat isn't reachable as a file from this sandbox (the uploads
// folder is empty on this end), so I rebuilt the look with a rounded
// Google font instead of the actual custom lettering. Swap in an <img> once
// you can get me the actual PNG/SVG file (e.g. drop it in the project and
// I can wire it up, or share it through a working file upload).
export default function Logo({ size = "md" }: { size?: "sm" | "md" }) {
  const textSize = size === "sm" ? "text-lg" : "text-2xl";
  return (
    <div className="leading-none select-none font-sans">
      <div className="text-[9px] tracking-[0.25em] text-pawpink-500 font-semibold -mb-0.5">THE</div>
      <div className={`${textSize} font-bold text-pawpink-500 tracking-tight`}>
        PAW<span className="italic">mart</span>
      </div>
    </div>
  );
}
