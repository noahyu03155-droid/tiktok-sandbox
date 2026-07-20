"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatTime } from "@/lib/format";
import { useLocale } from "@/lib/i18n";
import ProductPicker from "./ProductPicker";
import ProjectPickerModal from "./ProjectPickerModal";
import type { GeneratedScript, GeneratedScriptStage, VideoRecord } from "@/lib/types";

// "🖨 Print / PDF" on the Script Generator tab — opens a clean-print
// rendering of every stage's script + filming direction and fires the
// browser's print dialog, where "Save as PDF" is a standard option in every
// modern browser. Avoids pulling in a PDF-generation library just to
// produce a document whose whole point is "print it and bring it to set."
// Shows whichever version (current/previous) the user has actually picked
// per stage via the Old/New toggle, same as the on-screen card.
function printScript(script: GeneratedScript) {
  const w = window.open("", "_blank");
  if (!w) return;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const rows = script.stages
    .map((stage, i) => {
      const usePrevious = stage.previousScript != null && stage.selectedVersion === "previous";
      const text = usePrevious ? stage.previousScript || "" : stage.script;
      const direction = usePrevious ? stage.previousDirection || "" : stage.direction;
      return `
        <div class="shot">
          <h2>${i + 1}. ${esc(stage.label)}</h2>
          <p class="script">${esc(text)}</p>
          ${direction ? `<p class="notes">🎬 ${esc(direction)}</p>` : ""}
        </div>`;
    })
    .join("");
  w.document.write(`<!DOCTYPE html><html><head><title>${esc(script.shopify_product_title)} — Script</title><meta charset="utf-8"/><style>
    body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; padding: 32px; color: #111; max-width: 720px; margin: 0 auto; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    .meta { color: #666; font-size: 12px; margin-bottom: 24px; }
    .shot { padding: 14px 0; border-bottom: 1px solid #ddd; break-inside: avoid; }
    .shot h2 { font-size: 14px; margin: 0 0 6px; }
    .script { font-size: 13px; line-height: 1.6; margin: 0 0 8px; }
    .notes { font-size: 11px; color: #777; font-style: italic; margin: 0; }
    @media print { body { padding: 0; } }
  </style></head><body>
    <h1>${esc(script.shopify_product_title)}</h1>
    <p class="meta">${script.stages.length} beat${script.stages.length === 1 ? "" : "s"} · ${new Date().toLocaleDateString()}</p>
    ${rows}
  </body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
}

type TabKey = "transcript" | "hook" | "structure" | "selling" | "script";

export default function AnalysisTabs({
  video,
  onVideoUpdate,
}: {
  video: VideoRecord;
  onVideoUpdate?: (v: VideoRecord) => void;
}) {
  const [tab, setTab] = useState<TabKey>("hook");
  const [startingBreakdown, setStartingBreakdown] = useState(false);
  const { t } = useLocale();
  const router = useRouter();
  const analysis = video.analysis;
  const canRunBreakdown = video.status === "done" && !analysis && video.transcript_segments.length > 0;
  // Covers both an explicit status:"error" and the "done but somehow no
  // transcript" case (e.g. a transcribe_local.py crash that got caught
  // before status flipped to "error", or a stale record from before a
  // pipeline fix).
  const needsRetry =
    !analysis &&
    video.transcript_segments.length === 0 &&
    (video.status === "error" || video.status === "done");
  const [retrying, setRetrying] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function retryFetch() {
    setRetrying(true);
    await fetch(`/api/videos/${video.id}/retry`, { method: "POST" }).catch(() => {});
    pollRef.current = setInterval(async () => {
      const res = await fetch(`/api/videos/${video.id}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      onVideoUpdate?.(data.video);
      if (["done", "error"].includes(data.video.status)) {
        if (pollRef.current) clearInterval(pollRef.current);
        setRetrying(false);
      }
    }, 2500);
  }

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  async function runBreakdown() {
    setStartingBreakdown(true);
    await fetch(`/api/videos/${video.id}/analyze`, { method: "POST" }).catch(() => {});
    pollRef.current = setInterval(async () => {
      const res = await fetch(`/api/videos/${video.id}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      onVideoUpdate?.(data.video);
      if (["done", "error"].includes(data.video.status) && data.video.analysis) {
        if (pollRef.current) clearInterval(pollRef.current);
        setStartingBreakdown(false);
      } else if (data.video.status === "error") {
        if (pollRef.current) clearInterval(pollRef.current);
        setStartingBreakdown(false);
      }
    }, 2000);
  }

  const [showProductPicker, setShowProductPicker] = useState(false);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [importingToProject, setImportingToProject] = useState(false);
  const [storyboardImportError, setStoryboardImportError] = useState<string | null>(null);
  const [generatingScript, setGeneratingScript] = useState(false);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [activeScriptIdx, setActiveScriptIdx] = useState(video.generated_scripts.length - 1);

  // "Generate video — plan the storyboard" — pushes the active script's
  // stages into a Creation project the user explicitly picks (see
  // ProjectPickerModal), then navigates there so the cards are visible
  // right away instead of leaving the user to go find them.
  async function handleImportToProject(projectId: string) {
    const script = video.generated_scripts[activeScriptIdx];
    if (!script) return;
    setImportingToProject(true);
    setStoryboardImportError(null);
    try {
      const res = await fetch(`/api/creation/projects/${projectId}/storyboard/import-script`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stages: script.stages }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to add to that project");
      setShowProjectPicker(false);
      router.push(`/creation/${projectId}`);
    } catch (e: any) {
      setStoryboardImportError(e.message || "Failed to add to that project");
    } finally {
      setImportingToProject(false);
    }
  }

  async function runGenerateScript(body: { shopify_product_id: string } | { product_url: string }) {
    setShowProductPicker(false);
    setGeneratingScript(true);
    setScriptError(null);
    try {
      const res = await fetch(`/api/videos/${video.id}/generate-script`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to generate script");
      const updated = { ...video, generated_scripts: [...video.generated_scripts, data.script] };
      onVideoUpdate?.(updated);
      setActiveScriptIdx(updated.generated_scripts.length - 1);
    } catch (e: any) {
      setScriptError(e.message || "Failed to generate script");
    } finally {
      setGeneratingScript(false);
    }
  }

  function handleProductSelected(product: { id: string; title: string }) {
    runGenerateScript({ shopify_product_id: product.id });
  }

  // "Paste a link" tab on ProductPicker — not limited to Shopify, works for
  // any product page URL (see /api/videos/[id]/generate-script's
  // product_url branch, which scrapes it server-side).
  function handleProductLinkSelected(url: string) {
    runGenerateScript({ product_url: url });
  }

  // Called by a ScriptStageCard after a successful refine (server already
  // persisted it) or an Old/New pick (optimistic — the request to persist
  // fires in the background). Splices the single updated stage back into
  // the right script/index without touching the rest of the tree.
  function handleStageUpdated(scriptIdx: number, stageIdx: number, newStage: GeneratedScriptStage) {
    const updatedScripts = video.generated_scripts.map((s, si) =>
      si === scriptIdx
        ? { ...s, stages: s.stages.map((st, sti) => (sti === stageIdx ? newStage : st)) }
        : s
    );
    onVideoUpdate?.({ ...video, generated_scripts: updatedScripts });
  }

  const TABS: { key: TabKey; label: string }[] = [
    { key: "hook", label: t("tabHook") },
    { key: "structure", label: t("tabStructure") },
    { key: "selling", label: t("tabSelling") },
    { key: "transcript", label: t("tabTranscript") },
    { key: "script", label: "Script Generator" },
  ];

  return (
    <div>
      <div className="flex gap-1 border-b border-edge mb-4 overflow-x-auto">
        {TABS.map((tItem) => (
          <button
            key={tItem.key}
            onClick={() => setTab(tItem.key)}
            className={`px-4 py-2 text-sm whitespace-nowrap border-b-2 transition-colors ${
              tab === tItem.key
                ? "border-brand-500 text-zinc-900"
                : "border-transparent text-zinc-500 hover:text-zinc-800"
            }`}
          >
            {tItem.label}
          </button>
        ))}
      </div>

      {!analysis && canRunBreakdown && (
        <div className="text-center py-10">
          <p className="text-sm text-zinc-500 mb-3">{t("trendReadyNoBreakdown")}</p>
          <button
            onClick={runBreakdown}
            disabled={startingBreakdown}
            className="px-4 py-2 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white text-sm font-medium"
          >
            {startingBreakdown ? "..." : t("trendRunBreakdown")}
          </button>
        </div>
      )}
      {!analysis && !canRunBreakdown && needsRetry && (
        <div className="text-center py-10">
          <p className="text-sm text-red-400 mb-1">{t("transcriptFailed")}</p>
          {video.error_message && (
            <p className="text-xs text-zinc-500 mb-3 max-w-md mx-auto break-words">
              {video.error_message.split("\n")[0]}
            </p>
          )}
          <button
            onClick={retryFetch}
            disabled={retrying}
            className="px-4 py-2 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white text-sm font-medium"
          >
            {retrying ? "..." : t("retryFetch")}
          </button>
        </div>
      )}
      {!analysis && !canRunBreakdown && !needsRetry && <p className="text-sm text-zinc-500">{t("analysisNotReady")}</p>}

      {analysis && tab === "hook" && (
        <div className="space-y-4">
          <div className="bg-panel border border-edge rounded-xl p-4">
            <p className="text-xs text-zinc-500 mb-1">{t("hookOriginalText", { sec: analysis.hook.duration_sec })}</p>
            <p className="text-zinc-900 text-base leading-relaxed">"{analysis.hook.hook_text}"</p>
          </div>
          <div>
            <p className="text-xs text-zinc-500 mb-2">{t("hookTechniquesLabel")}</p>
            <div className="flex flex-wrap gap-2">
              {analysis.hook.techniques.map((tech, i) => (
                <span key={i} className="text-xs bg-brand-500/10 text-brand-400 border border-brand-500/30 rounded-full px-3 py-1">
                  {tech}
                </span>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs text-zinc-500 mb-1">{t("hookWhyLabel")}</p>
            <p className="text-sm text-zinc-700 leading-relaxed">{analysis.hook.why_it_works}</p>
          </div>
        </div>
      )}

      {analysis && tab === "structure" && (
        <div className="space-y-3">
          {analysis.structure.map((beat, i) => (
            <div key={i} className="flex gap-3 bg-panel border border-edge rounded-xl p-4">
              <div className="text-xs text-zinc-500 font-mono whitespace-nowrap pt-0.5 w-16 shrink-0">
                {formatTime(beat.start_time)}–{formatTime(beat.end_time)}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-brand-400">
                  {i + 1}. {beat.label}
                </p>
                <p className="text-sm text-zinc-700 mt-1 leading-relaxed">{beat.summary}</p>
                {beat.quote && (
                  <p className="text-xs text-zinc-500 italic mt-1.5">&ldquo;{beat.quote}&rdquo;</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {analysis && tab === "selling" && (
        <div className="space-y-5">
          <SellingSection title={t("sellingProductClaims")} items={analysis.selling_points.product_claims} />
          <SellingSection title={t("sellingEmotionalTriggers")} items={analysis.selling_points.emotional_triggers} />
          <SellingSection title={t("sellingCopyTechniques")} items={analysis.selling_points.copywriting_techniques} />
          <SellingSection title={t("sellingKeyPhrases")} items={analysis.selling_points.key_phrases} quote />
          <div>
            <p className="text-xs text-zinc-500 mb-1">{t("sellingCTA")}</p>
            <p className="text-sm text-zinc-900 bg-panel border border-edge rounded-xl p-3">
              {analysis.selling_points.call_to_action}
            </p>
          </div>
        </div>
      )}

      {tab === "transcript" && (
        <div className="space-y-2">
          {video.transcript_segments.length === 0 && <p className="text-sm text-zinc-500">{t("noTranscript")}</p>}
          {video.transcript_segments.map((seg, i) => (
            <div key={i} className="flex gap-3 text-sm py-1.5 border-b border-edge">
              <span className="text-zinc-500 font-mono text-xs whitespace-nowrap pt-0.5">
                {formatTime(seg.start)}
              </span>
              <span className="text-zinc-800 leading-relaxed">{seg.text}</span>
            </div>
          ))}
        </div>
      )}

      {tab === "script" && (
        <div>
          {!analysis && (
            <p className="text-sm text-zinc-500">Run the breakdown first — the script generator uses it as a reference.</p>
          )}
          {analysis && (
            <div className="space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <p className="text-xs text-zinc-500 max-w-md">
                  Pick one of our Shopify products (or paste any product link), and Claude will adapt this video's
                  structure and hooks into a new script for briefing a creator.
                </p>
                <button
                  onClick={() => setShowProductPicker(true)}
                  disabled={generatingScript}
                  className="px-4 py-2 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white text-sm font-medium whitespace-nowrap"
                >
                  {generatingScript ? "Generating..." : "Generate script"}
                </button>
              </div>

              {scriptError && <p className="text-sm text-red-400">{scriptError}</p>}

              {video.generated_scripts.length > 0 && (
                <>
                  {video.generated_scripts.length > 1 && (
                    <div className="flex flex-wrap gap-1.5">
                      {video.generated_scripts.map((s, i) => (
                        <button
                          key={s.id}
                          onClick={() => setActiveScriptIdx(i)}
                          className={`text-xs px-3 py-1 rounded-full border ${
                            i === activeScriptIdx
                              ? "bg-brand-500 text-white border-brand-500"
                              : "text-zinc-500 border-edge hover:border-edge2"
                          }`}
                        >
                          {s.shopify_product_title}
                        </button>
                      ))}
                    </div>
                  )}

                  {video.generated_scripts[activeScriptIdx] && (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <p className="text-sm text-zinc-900 font-medium">
                          For: {video.generated_scripts[activeScriptIdx].shopify_product_title}
                        </p>
                        <button
                          onClick={() => printScript(video.generated_scripts[activeScriptIdx])}
                          title="Print this script + shooting guide (or save as PDF from the print dialog)"
                          className="text-xs px-2.5 py-1 rounded border border-edge text-zinc-600 hover:text-zinc-900 hover:border-edge2"
                        >
                          🖨 Print / PDF
                        </button>
                      </div>
                      {video.generated_scripts[activeScriptIdx].stages.map((stage, i) => (
                        <ScriptStageCard
                          key={i}
                          stage={stage}
                          index={i}
                          videoId={video.id}
                          scriptId={video.generated_scripts[activeScriptIdx].id}
                          onUpdated={(newStage) => handleStageUpdated(activeScriptIdx, i, newStage)}
                        />
                      ))}
                      <button
                        onClick={() => setShowProjectPicker(true)}
                        className="w-full py-2.5 rounded-lg border border-dashed border-edge2 text-zinc-600 hover:text-zinc-900 hover:border-brand-500 text-sm font-medium"
                      >
                        🎬 Generate video — plan the storyboard
                      </button>
                      {storyboardImportError && <p className="text-sm text-red-400">{storyboardImportError}</p>}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {showProductPicker && (
        <ProductPicker
          onSelect={handleProductSelected}
          onSelectLink={handleProductLinkSelected}
          onClose={() => setShowProductPicker(false)}
        />
      )}

      {showProjectPicker && (
        <ProjectPickerModal
          title="Add this script's storyboard to which canvas project?"
          confirmLabel={importingToProject ? "Adding..." : "Add here"}
          onPick={handleImportToProject}
          onClose={() => setShowProjectPicker(false)}
        />
      )}
    </div>
  );
}

function SellingSection({ title, items, quote }: { title: string; items: string[]; quote?: boolean }) {
  if (!items || items.length === 0) return null;
  return (
    <div>
      <p className="text-xs text-zinc-500 mb-2">{title}</p>
      <ul className="space-y-1.5">
        {items.map((item, i) => (
          <li key={i} className="text-sm text-zinc-800 bg-panel border border-edge rounded-lg px-3 py-2">
            {quote ? `"${item}"` : item}
          </li>
        ))}
      </ul>
    </div>
  );
}

// One generated-script beat: the current (or, if the user picked "Old",
// previous) script + direction on the left, and a small feedback panel on
// the right so a reviewer can nudge just this one beat without regenerating
// the whole script. After a refine, both versions stick around and the user
// picks which one is "final" via the Old/New toggle — nothing is silently
// overwritten.
function ScriptStageCard({
  stage,
  index,
  videoId,
  scriptId,
  onUpdated,
}: {
  stage: GeneratedScriptStage;
  index: number;
  videoId: string;
  scriptId: string;
  onUpdated: (stage: GeneratedScriptStage) => void;
}) {
  const { t } = useLocale();
  const [feedback, setFeedback] = useState("");
  const [refining, setRefining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasPrevious = stage.previousScript != null;
  const selected: "current" | "previous" =
    hasPrevious && stage.selectedVersion === "previous" ? "previous" : "current";
  const shown =
    selected === "previous"
      ? { script: stage.previousScript || "", direction: stage.previousDirection || "" }
      : { script: stage.script, direction: stage.direction };

  async function submitFeedback() {
    const trimmed = feedback.trim();
    if (!trimmed) return;
    setRefining(true);
    setError(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/generate-script/${scriptId}/refine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stageIndex: index, feedback: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update this beat");
      onUpdated(data.script.stages[index]);
      setFeedback("");
    } catch (e: any) {
      setError(e.message || "Failed to update this beat");
    } finally {
      setRefining(false);
    }
  }

  function pickVersion(version: "current" | "previous") {
    if (version === selected) return;
    onUpdated({ ...stage, selectedVersion: version });
    fetch(`/api/videos/${videoId}/generate-script/${scriptId}/select-version`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stageIndex: index, version }),
    }).catch(() => {});
  }

  return (
    <div className="bg-panel border border-edge rounded-xl p-4 grid grid-cols-1 lg:grid-cols-[1fr_220px] gap-4">
      <div className="min-w-0">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-sm font-medium text-brand-400">
            {index + 1}. {stage.label}
          </p>
          {hasPrevious && (
            <div className="flex items-center gap-0.5 bg-panel2 rounded-full p-0.5">
              <button
                onClick={() => pickVersion("previous")}
                className={`text-[11px] px-2 py-0.5 rounded-full transition-colors ${
                  selected === "previous" ? "bg-panel shadow-sm text-zinc-900" : "text-zinc-500 hover:text-zinc-800"
                }`}
              >
                {t("scriptVersionOld")}
              </button>
              <button
                onClick={() => pickVersion("current")}
                className={`text-[11px] px-2 py-0.5 rounded-full transition-colors ${
                  selected === "current" ? "bg-panel shadow-sm text-zinc-900" : "text-zinc-500 hover:text-zinc-800"
                }`}
              >
                {t("scriptVersionNew")}
              </button>
            </div>
          )}
        </div>
        <p className="text-sm text-zinc-800 mt-1.5 leading-relaxed">{shown.script}</p>
        {shown.direction && <p className="text-xs text-zinc-500 italic mt-1.5">🎬 {shown.direction}</p>}
      </div>

      <div className="border-t lg:border-t-0 lg:border-l border-edge pt-3 lg:pt-0 lg:pl-4 flex flex-col">
        <p className="text-[11px] text-zinc-500 mb-1">{t("scriptFeedbackLabel")}</p>
        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder={t("scriptFeedbackPlaceholder")}
          rows={3}
          className="flex-1 resize-none bg-panel2 border border-edge rounded-lg px-2 py-1.5 text-xs text-zinc-900 placeholder:text-zinc-500 outline-none focus:border-brand-500"
        />
        {error && <p className="text-[11px] text-red-400 mt-1">{error}</p>}
        <button
          onClick={submitFeedback}
          disabled={refining || !feedback.trim()}
          className="mt-2 text-xs px-3 py-1.5 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white font-medium self-start"
        >
          {refining ? t("scriptFeedbackUpdating") : t("scriptFeedbackUpdate")}
        </button>
      </div>
    </div>
  );
}
