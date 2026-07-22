"use client";

import { useEffect, useState } from "react";
import type { PromoCode } from "@/lib/types";

// Admin "Code Generator" page body (route gate lives in src/app/codes/
// page.tsx). Two code kinds share one table: plain discount codes and
// affiliate codes — the latter carry the creator's name and a commission
// percent, and every purchase made with one is logged so the totals here
// double as the payout ledger.
export default function CodesPageContent() {
  const [codes, setCodes] = useState<PromoCode[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Create form state.
  const [kind, setKind] = useState<"discount" | "affiliate">("discount");
  const [customCode, setCustomCode] = useState("");
  const [percentOff, setPercentOff] = useState(10);
  const [commissionPercent, setCommissionPercent] = useState(20);
  const [affiliateName, setAffiliateName] = useState("");
  const [creating, setCreating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function loadCodes() {
    try {
      const res = await fetch("/api/promo-codes", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to load codes");
      setCodes(data.codes || []);
    } catch (e: any) {
      setError(e.message || "Failed to load codes");
    }
  }

  useEffect(() => {
    loadCodes();
  }, []);

  async function createCode() {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/promo-codes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          code: customCode.trim() || undefined,
          percentOff,
          commissionPercent: kind === "affiliate" ? commissionPercent : 0,
          affiliateName: kind === "affiliate" ? affiliateName : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to create the code");
      setCustomCode("");
      setAffiliateName("");
      await loadCodes();
    } catch (e: any) {
      setError(e.message || "Failed to create the code");
    } finally {
      setCreating(false);
    }
  }

  async function toggleActive(code: PromoCode) {
    await fetch(`/api/promo-codes/${code.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !code.active }),
    }).catch(() => {});
    loadCodes();
  }

  async function removeCode(code: PromoCode) {
    if (!window.confirm(`Delete code ${code.code}? Its usage/commission history is deleted with it — deactivate instead if you need the ledger.`)) return;
    await fetch(`/api/promo-codes/${code.id}`, { method: "DELETE" }).catch(() => {});
    loadCodes();
  }

  function copyCode(code: PromoCode) {
    navigator.clipboard?.writeText(code.code).then(() => {
      setCopiedId(code.id);
      setTimeout(() => setCopiedId((cur) => (cur === code.id ? null : cur)), 1500);
    });
  }

  const sum = (uses: PromoCode["uses"], field: "totalUsd" | "discountUsd" | "commissionUsd") =>
    Math.round(uses.reduce((acc, u) => acc + (u[field] || 0), 0) * 100) / 100;

  return (
    <div>
      <h1 className="text-xl font-semibold text-zinc-900 mb-1">Code Generator</h1>
      <p className="text-sm text-zinc-500 mb-6">
        Discount codes give buyers a percentage off at checkout. Affiliate codes do the same AND log a commission for
        the creator on every purchase — the totals below are the payout ledger.
      </p>

      {/* ---- create form ---- */}
      <div className="rounded-xl border border-edge bg-panel p-4 mb-8">
        <div className="flex items-center gap-2 mb-3">
          {(["discount", "affiliate"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                kind === k ? "bg-zinc-900 text-white border-zinc-900" : "bg-panel text-zinc-600 border-edge hover:border-zinc-400"
              }`}
            >
              {k === "discount" ? "💸 Discount code" : "🤝 Affiliate code"}
            </button>
          ))}
        </div>
        <div className="flex items-end gap-3 flex-wrap">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-zinc-500">Code (blank = auto-generate)</span>
            <input
              value={customCode}
              onChange={(e) => setCustomCode(e.target.value.toUpperCase())}
              placeholder="e.g. SUMMER20"
              maxLength={20}
              className="px-3 py-2 rounded-lg bg-panel2 border border-edge text-sm text-zinc-900 outline-none focus:border-brand-500 font-mono w-40"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-zinc-500">Buyer discount %</span>
            <input
              type="number"
              min={1}
              max={90}
              value={percentOff}
              onChange={(e) => setPercentOff(Math.max(1, Math.min(90, Number(e.target.value) || 1)))}
              className="px-3 py-2 rounded-lg bg-panel2 border border-edge text-sm text-zinc-900 outline-none focus:border-brand-500 w-24"
            />
          </label>
          {kind === "affiliate" && (
            <>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-zinc-500">Creator name / handle</span>
                <input
                  value={affiliateName}
                  onChange={(e) => setAffiliateName(e.target.value)}
                  placeholder="@creatorhandle"
                  maxLength={80}
                  className="px-3 py-2 rounded-lg bg-panel2 border border-edge text-sm text-zinc-900 outline-none focus:border-brand-500 w-48"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-zinc-500">Commission % (of paid amount)</span>
                <input
                  type="number"
                  min={0}
                  max={90}
                  value={commissionPercent}
                  onChange={(e) => setCommissionPercent(Math.max(0, Math.min(90, Number(e.target.value) || 0)))}
                  className="px-3 py-2 rounded-lg bg-panel2 border border-edge text-sm text-zinc-900 outline-none focus:border-brand-500 w-24"
                />
              </label>
            </>
          )}
          <button
            onClick={createCode}
            disabled={creating || (kind === "affiliate" && !affiliateName.trim())}
            className="px-5 py-2 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white text-sm font-medium"
          >
            {creating ? "Creating…" : "+ Generate code"}
          </button>
        </div>
        {error && <p className="text-sm text-red-400 mt-2">{error}</p>}
      </div>

      {/* ---- codes table ---- */}
      {!codes && <p className="text-sm text-zinc-500">Loading…</p>}
      {codes && codes.length === 0 && <p className="text-sm text-zinc-500">No codes yet — generate the first one above.</p>}
      {codes && codes.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-edge">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-panel text-left text-[11px] uppercase tracking-wide text-zinc-500">
                <th className="px-3 py-2.5">Code</th>
                <th className="px-3 py-2.5">Kind</th>
                <th className="px-3 py-2.5">Discount</th>
                <th className="px-3 py-2.5">Creator</th>
                <th className="px-3 py-2.5">Commission %</th>
                <th className="px-3 py-2.5">Uses</th>
                <th className="px-3 py-2.5">Revenue</th>
                <th className="px-3 py-2.5">Commission owed</th>
                <th className="px-3 py-2.5">Status</th>
                <th className="px-3 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {codes.map((c) => (
                <tr key={c.id} className="border-t border-edge">
                  <td className="px-3 py-2.5 font-mono font-semibold text-zinc-900">
                    <button onClick={() => copyCode(c)} title="Copy code" className="hover:text-brand-500">
                      {c.code} {copiedId === c.id ? "✓" : "⧉"}
                    </button>
                  </td>
                  <td className="px-3 py-2.5">{c.kind === "affiliate" ? "🤝 Affiliate" : "💸 Discount"}</td>
                  <td className="px-3 py-2.5">-{c.percentOff}%</td>
                  <td className="px-3 py-2.5 text-zinc-600">{c.affiliateName || "—"}</td>
                  <td className="px-3 py-2.5">{c.kind === "affiliate" ? `${c.commissionPercent}%` : "—"}</td>
                  <td className="px-3 py-2.5">{c.uses.length}</td>
                  <td className="px-3 py-2.5">${sum(c.uses, "totalUsd")}</td>
                  <td className="px-3 py-2.5 font-medium text-zinc-900">
                    {c.kind === "affiliate" ? `$${sum(c.uses, "commissionUsd")}` : "—"}
                  </td>
                  <td className="px-3 py-2.5">
                    <button
                      onClick={() => toggleActive(c)}
                      className={`text-[11px] px-2.5 py-1 rounded-full ${
                        c.active ? "bg-emerald-500/10 text-emerald-600" : "bg-zinc-500/10 text-zinc-500"
                      }`}
                    >
                      {c.active ? "Active" : "Disabled"}
                    </button>
                  </td>
                  <td className="px-3 py-2.5">
                    <button onClick={() => removeCode(c)} className="text-zinc-400 hover:text-red-500 text-xs">
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
