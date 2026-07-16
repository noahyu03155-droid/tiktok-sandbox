"use client";

// Floating, draggable robot assistant. Polls /api/ai-activity: while any
// Claude task is running server-side it plays a "working" animation, and
// when the last task finishes it says "Done!" for a few seconds.

import { useCallback, useEffect, useRef, useState } from "react";

type Mood = "idle" | "working" | "done";

const POLL_MS = 2000;
const DONE_SHOW_MS = 4000;
const POS_KEY = "robot-assistant-pos";
const ROBOT_W = 96;
const ROBOT_H = 120;

function clampToViewport(x: number, y: number) {
  const maxX = Math.max(0, window.innerWidth - ROBOT_W);
  const maxY = Math.max(0, window.innerHeight - ROBOT_H);
  return { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) };
}

export default function RobotAssistant() {
  const [mood, setMood] = useState<Mood>("idle");
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const prevActiveRef = useRef(0);
  const doneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragOffsetRef = useRef({ dx: 0, dy: 0 });

  // Initial position: bottom-right, or wherever it was last dragged to.
  useEffect(() => {
    let saved: { x: number; y: number } | null = null;
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch {
      /* ignore corrupt storage */
    }
    const fallback = { x: window.innerWidth - ROBOT_W - 24, y: window.innerHeight - ROBOT_H - 24 };
    const p = saved && typeof saved.x === "number" && typeof saved.y === "number" ? saved : fallback;
    setPos(clampToViewport(p.x, p.y));

    const onResize = () => setPos((cur) => (cur ? clampToViewport(cur.x, cur.y) : cur));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Poll the server for in-flight Claude work.
  useEffect(() => {
    let stopped = false;

    const tick = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const res = await fetch("/api/ai-activity", { cache: "no-store" });
        if (!res.ok) return; // e.g. 401 on the login page — stay idle
        const data = (await res.json()) as { active: number };
        if (stopped) return;

        const wasActive = prevActiveRef.current;
        prevActiveRef.current = data.active;

        if (data.active > 0) {
          if (doneTimerRef.current) {
            clearTimeout(doneTimerRef.current);
            doneTimerRef.current = null;
          }
          setMood("working");
        } else if (wasActive > 0) {
          setMood("done");
          doneTimerRef.current = setTimeout(() => setMood("idle"), DONE_SHOW_MS);
        }
      } catch {
        /* network hiccup — keep current mood */
      }
    };

    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
      if (doneTimerRef.current) clearTimeout(doneTimerRef.current);
    };
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!pos) return;
      e.preventDefault();
      try {
        (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      } catch {
        /* synthetic/stale pointer — dragging still works via bubbled moves */
      }
      dragOffsetRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
      setDragging(true);
    },
    [pos]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      const { dx, dy } = dragOffsetRef.current;
      setPos(clampToViewport(e.clientX - dx, e.clientY - dy));
    },
    [dragging]
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      try {
        (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
      } catch {
        /* capture may not have been acquired */
      }
      setDragging(false);
      setPos((cur) => {
        if (cur) {
          try {
            localStorage.setItem(POS_KEY, JSON.stringify(cur));
          } catch {
            /* storage unavailable */
          }
        }
        return cur;
      });
    },
    [dragging]
  );

  if (!pos) return null;

  const bubbleText = mood === "working" ? "Working" : mood === "done" ? "Done!" : null;

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        position: "fixed",
        left: pos.x,
        top: pos.y,
        width: ROBOT_W,
        zIndex: 9999,
        cursor: dragging ? "grabbing" : "grab",
        touchAction: "none",
        userSelect: "none",
      }}
      aria-label="AI assistant robot"
      title="Drag me anywhere"
    >
      <style>{`
        @keyframes robot-bob {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-5px); }
        }
        @keyframes robot-shake {
          0%, 100% { transform: translateY(0) rotate(0deg); }
          25% { transform: translateY(-2px) rotate(-2deg); }
          75% { transform: translateY(-2px) rotate(2deg); }
        }
        @keyframes robot-antenna-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.25; }
        }
        @keyframes robot-eye-scan {
          0%, 100% { transform: translateX(0); }
          30% { transform: translateX(-4px); }
          70% { transform: translateX(4px); }
        }
        @keyframes robot-blink {
          0%, 92%, 100% { transform: scaleY(1); }
          95% { transform: scaleY(0.1); }
        }
        @keyframes robot-dots {
          0% { content: ""; }
        }
        @keyframes robot-dot-pulse {
          0%, 80%, 100% { opacity: 0.2; }
          40% { opacity: 1; }
        }
        @keyframes robot-bubble-pop {
          0% { transform: scale(0.6); opacity: 0; }
          100% { transform: scale(1); opacity: 1; }
        }
      `}</style>

      {/* Speech bubble */}
      {bubbleText && (
        <div
          style={{
            position: "absolute",
            bottom: ROBOT_H - 8,
            left: "50%",
            transform: "translateX(-50%)",
            background: mood === "done" ? "#22c55e" : "#0ea5e9",
            color: "white",
            fontSize: 12,
            fontWeight: 700,
            padding: "4px 10px",
            borderRadius: 12,
            whiteSpace: "nowrap",
            boxShadow: "0 4px 12px rgba(0,0,0,0.35)",
            animation: "robot-bubble-pop 0.25s ease-out",
            display: "flex",
            alignItems: "center",
            gap: 2,
          }}
        >
          {bubbleText}
          {mood === "working" && (
            <span style={{ display: "inline-flex", gap: 2, marginLeft: 2 }}>
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  style={{
                    width: 3,
                    height: 3,
                    borderRadius: "50%",
                    background: "white",
                    animation: `robot-dot-pulse 1.2s ${i * 0.2}s infinite`,
                  }}
                />
              ))}
            </span>
          )}
        </div>
      )}

      {/* Robot body */}
      <div
        style={{
          animation: dragging
            ? "none"
            : mood === "working"
            ? "robot-shake 0.8s ease-in-out infinite"
            : "robot-bob 3s ease-in-out infinite",
          filter: "drop-shadow(0 6px 10px rgba(0,0,0,0.35))",
        }}
      >
        <svg viewBox="0 0 96 120" width={ROBOT_W} height={ROBOT_H}>
          {/* Antenna */}
          <line x1="48" y1="14" x2="48" y2="26" stroke="#93c5fd" strokeWidth="3" strokeLinecap="round" />
          <circle
            cx="48"
            cy="10"
            r="6"
            fill={mood === "working" ? "#f97316" : "#fb923c"}
            style={{ animation: mood === "working" ? "robot-antenna-blink 0.6s infinite" : "none" }}
          />

          {/* Ears */}
          <rect x="2" y="44" width="10" height="22" rx="5" fill="#60a5fa" />
          <rect x="84" y="44" width="10" height="22" rx="5" fill="#60a5fa" />

          {/* Head */}
          <rect x="10" y="24" width="76" height="62" rx="20" fill="#e8f4fb" stroke="#bfdbfe" strokeWidth="2" />

          {/* Face screen */}
          <rect x="20" y="34" width="56" height="42" rx="14" fill="#0f2137" />

          {/* Eyes */}
          {mood === "done" ? (
            // happy ^_^ eyes
            <g stroke="#67e8f9" strokeWidth="4" strokeLinecap="round" fill="none">
              <path d="M31 56 q5 -8 10 0" />
              <path d="M55 56 q5 -8 10 0" />
            </g>
          ) : (
            <g
              style={{
                animation: mood === "working" ? "robot-eye-scan 1.6s ease-in-out infinite" : "none",
              }}
            >
              <g style={{ animation: mood === "idle" ? "robot-blink 4s infinite" : "none", transformOrigin: "48px 54px" }}>
                <rect x="30" y="46" width="12" height="16" rx="6" fill="#67e8f9" />
                <rect x="54" y="46" width="12" height="16" rx="6" fill="#67e8f9" />
              </g>
            </g>
          )}

          {/* Mouth */}
          <path
            d={mood === "done" ? "M40 66 q8 8 16 0" : "M42 67 q6 5 12 0"}
            stroke="#67e8f9"
            strokeWidth="3"
            strokeLinecap="round"
            fill="none"
          />

          {/* Body */}
          <rect x="26" y="88" width="44" height="26" rx="12" fill="#dceefb" stroke="#bfdbfe" strokeWidth="2" />
          <circle cx="48" cy="101" r="6" fill={mood === "working" ? "#f97316" : "#93c5fd"} style={{ animation: mood === "working" ? "robot-antenna-blink 0.9s infinite" : "none" }} />

          {/* Arms */}
          <rect x="14" y="92" width="10" height="18" rx="5" fill="#93c5fd" transform={mood === "working" ? "rotate(-15 19 101)" : undefined} />
          <rect x="72" y="92" width="10" height="18" rx="5" fill="#93c5fd" transform={mood === "working" ? "rotate(15 77 101)" : undefined} />
        </svg>
      </div>
    </div>
  );
}
