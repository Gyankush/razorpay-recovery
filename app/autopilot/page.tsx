"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Bot,
  Play,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  KeyRound,
  Save,
  CheckCircle2,
  FlaskConical,
  Sparkles,
  ArrowRight,
} from "lucide-react";
import { adminHeaders, getAdminKey, setAdminKey } from "@/lib/admin-key";

interface MerchantRow {
  merchant: { id: string; name: string; mode: string };
  policy: {
    id: string;
    merchantId: string;
    enabled: boolean;
    allowed_categories: string[];
    maxAutoAmount: number;
    maxActionsPerRun: number;
    minConfidence: string | number | null;
  };
}

interface Brief {
  generated_at: string;
  last_24h: { new_cases: number; resolved: number; auto_recovered: number; open_now: number };
  recovery_rate_7d_pct: number;
  top_category_7d: string | null;
  open_by_category: Array<{ category: string; count: number }>;
  anomalies: Array<{ severity: "info" | "warn"; message: string }>;
}

const SAFE_CATEGORIES = ["customer_action", "transient"];
const NEVER_AUTO = ["risk_block", "merchant_config", "unknown"];

export default function AutopilotPage() {
  const [rows, setRows] = useState<MerchantRow[]>([]);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [demoMode, setDemoMode] = useState(false);
  const [key, setKey] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const load = async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const [pRes, bRes, dRes] = await Promise.all([
        fetch("/api/autopilot/policy", { headers: adminHeaders() }),
        fetch("/api/agent/brief", { headers: adminHeaders() }),
        fetch("/api/demo/status").catch(() => null),
      ]);
      if (dRes && dRes.ok) {
        const d = await dRes.json();
        setDemoMode(d.demo_mode === true);
      }
      let ok = false;
      if (pRes.ok) {
        const p = await pRes.json();
        setRows(p.merchants || []);
        ok = true;
      }
      if (bRes.ok) {
        const b = await bRes.json();
        setBrief(b.brief);
        ok = true;
      }
      if (!ok) {
        setLoadError(
          "This deployment is locked: paste the operator key above to view the copilot brief and guardrails."
        );
      }
    } catch (err) {
      console.error("Failed to load autopilot:", err);
      setLoadError("Could not reach the autopilot API. Check your connection and retry.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setKey(getAdminKey());
    load();
  }, []);

  const flash = (ok: boolean, text: string) => {
    setNotice({ ok, text });
    setTimeout(() => setNotice(null), 5000);
  };

  const savePolicy = async (row: MerchantRow) => {
    try {
      setSavingId(row.merchant.id);
      const res = await fetch("/api/autopilot/policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({
          merchant_id: row.merchant.id,
          enabled: row.policy.enabled,
          allowed_categories: row.policy.allowed_categories,
          max_auto_amount: row.policy.maxAutoAmount,
          max_actions_per_run: row.policy.maxActionsPerRun,
          min_confidence: Number(row.policy.minConfidence ?? 0.7),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        flash(true, `Policy saved for ${row.merchant.name}`);
        await load();
      } else {
        flash(false, data.error || "Failed to save policy");
      }
    } catch {
      flash(false, "Failed to save policy");
    } finally {
      setSavingId(null);
    }
  };

  const runNow = async () => {
    try {
      setRunning(true);
      const res = await fetch("/api/agent/run", {
        method: "POST",
        headers: adminHeaders(),
      });
      const data = await res.json();
      if (res.ok) {
        flash(
          true,
          `Agent run finished: ${data.report.auto_executed} auto-recovered, ${data.report.skipped.length} skipped for humans.`
        );
        await load();
      } else {
        flash(false, data.error || "Agent run failed");
      }
    } catch {
      flash(false, "Agent run failed");
    } finally {
      setRunning(false);
    }
  };

  const patchRow = (id: string, patch: Partial<MerchantRow["policy"]>) =>
    setRows((rs) => rs.map((r) => (r.merchant.id === id ? { ...r, policy: { ...r.policy, ...patch } } : r)));

  return (
    <div className="min-h-screen bg-[#f4f7fa] text-[#17212b] pb-16">
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-[#dfe6ee] px-6 py-3.5">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#dfe6ee] hover:bg-slate-50 text-xs font-bold text-[#12304a] transition"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Control Room
            </Link>
            <div className="flex items-center gap-2">
              <Bot className="w-5 h-5 text-[#2ca7b8]" />
              <h1 className="text-lg font-bold tracking-tight text-[#12304a]">Autopilot</h1>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <label className="relative text-xs">
              <span className="sr-only">Operator key</span>
              <KeyRound className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#637181]" aria-hidden />
              <input
                type="password"
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                  setAdminKey(e.target.value);
                }}
                placeholder="Operator key (x-admin-secret)"
                autoComplete="off"
                className="pl-8 pr-3 py-1.5 rounded-lg border border-[#dfe6ee] text-xs w-56 bg-white focus:outline-none focus:border-[#2ca7b8]"
              />
            </label>
            <button
              onClick={load}
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#dfe6ee] text-xs font-semibold text-[#637181] hover:text-[#12304a] hover:bg-slate-50 transition"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
            </button>
            <button
              onClick={runNow}
              disabled={running}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#12304a] hover:bg-[#164b66] text-white text-xs font-bold transition disabled:opacity-50"
            >
              {running ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              Run agent now
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 pt-8 space-y-6">
        {notice && (
          <div
            role="status"
            className={`p-4 rounded-xl border text-sm font-medium animate-fadeIn ${
              notice.ok
                ? "bg-[#dff5ef] border-[#b6e7dc] text-[#136456]"
                : "bg-[#ffe5e5] border-[#f1bfc5] text-[#8c3340]"
            }`}
          >
            {notice.text}
          </div>
        )}

        <div>
          <div className="text-xs font-bold uppercase tracking-wider text-[#2ca7b8] mb-1">Autonomous recovery</div>
          <h2 className="text-2xl font-extrabold text-[#12304a] tracking-tight">Copilot brief &amp; guardrails</h2>
          <p className="text-sm text-[#637181] mt-1 max-w-3xl">
            One AI pipeline: <strong>Diagnose</strong> explains every failure,{" "}
            <strong>Autopilot</strong> auto-recovers only allowlisted, under-cap, high-confidence
            cases, and the <strong>Brief</strong> below watches recovery rate and anomalies.
            Risk, config and unknown cases always stay human — every decision lands in the audit trail.
          </p>
        </div>

        {demoMode && (
          <div className="p-4 rounded-2xl bg-white border-2 border-dashed border-[#2ca7b8] text-xs text-[#4e6574] animate-fadeIn">
            <div className="flex items-center gap-1.5 font-extrabold text-[#12304a] text-sm mb-1.5">
              <FlaskConical className="w-4 h-4 text-[#2ca7b8]" />
              Try the autonomy loop — no key needed in this sandbox
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>1. Flip a merchant <strong>Autopilot ON</strong> + Save</span>
              <ArrowRight className="w-3 h-3" />
              <span>2. <Link href="/" className="font-bold text-[#1d6b9f] hover:underline">Seed a failure</Link></span>
              <ArrowRight className="w-3 h-3" />
              <span>3. <strong>Run agent now</strong> — watch it auto-recover safe cases and skip the rest with reasons</span>
            </div>
          </div>
        )}

        {loadError && (
          <div role="alert" className="p-4 rounded-xl bg-[#ffe5e5] border border-[#f1bfc5] text-[#8c3340] text-sm font-medium animate-fadeIn">
            {loadError}
          </div>
        )}

        {/* Brief */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {[
            { label: "New cases · 24h", value: brief ? brief.last_24h.new_cases : "—" },
            { label: "Auto-recovered · 24h", value: brief ? brief.last_24h.auto_recovered : "—" },
            { label: "Open now", value: brief ? brief.last_24h.open_now : "—" },
            { label: "Recovery rate · 7d", value: brief ? `${brief.recovery_rate_7d_pct}%` : "—" },
          ].map((s) => (
            <div key={s.label} className="p-5 rounded-2xl bg-white border border-[#dfe6ee] shadow-sm card-hover">
              <div className="text-xs font-bold text-[#637181] uppercase tracking-wider mb-1">{s.label}</div>
              <div className="text-3xl font-extrabold text-[#12304a] num">{s.value}</div>
            </div>
          ))}
        </div>

        {brief && brief.anomalies.length > 0 && (
          <div className="space-y-2">
            {brief.anomalies.map((a, i) => (
              <div
                key={i}
                className={`p-4 rounded-xl border text-sm flex items-start gap-2 ${
                  a.severity === "warn"
                    ? "bg-[#fff1c7] border-[#f1d885] text-[#725311]"
                    : "bg-[#e9f4fc] border-[#b9dbf4] text-[#1d5d86]"
                }`}
              >
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{a.message}</span>
              </div>
            ))}
          </div>
        )}

        {/* Policies */}
        {loading && rows.length === 0 ? (
          <div className="p-6 space-y-3" role="status" aria-label="Loading policies">
            {[0, 1].map((i) => (
              <div key={i} className="skeleton h-40 w-full rounded-2xl" />
            ))}
          </div>
        ) : (
          rows.map((row) => (
            <section key={row.merchant.id} className="p-6 rounded-2xl bg-white border border-[#dfe6ee] shadow-sm space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-base font-bold text-[#12304a]">{row.merchant.name}</h3>
                  <p className="text-xs text-[#637181] font-mono">{row.merchant.id.slice(0, 8)} · {row.merchant.mode}</p>
                </div>
                <button
                  role="switch"
                  aria-checked={row.policy.enabled}
                  onClick={() => patchRow(row.merchant.id, { enabled: !row.policy.enabled })}
                  className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition ${
                    row.policy.enabled
                      ? "bg-[#dff5ef] text-[#136456] border border-[#b6e7dc]"
                      : "bg-white text-[#637181] border border-[#dfe6ee] hover:bg-slate-50"
                  }`}
                >
                  {row.policy.enabled ? <CheckCircle2 className="w-4 h-4" /> : <ShieldAlert className="w-4 h-4" />}
                  {row.policy.enabled ? "Autopilot ON" : "Autopilot OFF"}
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                <label className="space-y-1">
                  <span className="font-bold text-[#12304a]">Max auto amount (minor units)</span>
                  <input
                    type="number"
                    min={100}
                    max={10000000}
                    value={row.policy.maxAutoAmount}
                    onChange={(e) => patchRow(row.merchant.id, { maxAutoAmount: Number(e.target.value) })}
                    className="w-full px-3 py-2 border border-[#dfe6ee] rounded-lg focus:outline-none focus:border-[#2ca7b8] num"
                  />
                </label>
                <label className="space-y-1">
                  <span className="font-bold text-[#12304a]">Max actions / run (1–50)</span>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={row.policy.maxActionsPerRun}
                    onChange={(e) => patchRow(row.merchant.id, { maxActionsPerRun: Number(e.target.value) })}
                    className="w-full px-3 py-2 border border-[#dfe6ee] rounded-lg focus:outline-none focus:border-[#2ca7b8] num"
                  />
                </label>
                <label className="space-y-1">
                  <span className="font-bold text-[#12304a]">Min confidence (0.50–1.00)</span>
                  <input
                    type="number"
                    step="0.01"
                    min={0.5}
                    max={1}
                    value={Number(row.policy.minConfidence ?? 0.7)}
                    onChange={(e) => patchRow(row.merchant.id, { minConfidence: e.target.value as unknown as number })}
                    className="w-full px-3 py-2 border border-[#dfe6ee] rounded-lg focus:outline-none focus:border-[#2ca7b8] num"
                  />
                </label>
              </div>

              <div>
                <div className="text-xs font-bold text-[#12304a] mb-2">Auto-handle categories</div>
                <div className="flex flex-wrap gap-2">
                  {SAFE_CATEGORIES.map((c) => {
                    const on = row.policy.allowed_categories.includes(c);
                    return (
                      <button
                        key={c}
                        onClick={() =>
                          patchRow(row.merchant.id, {
                            allowed_categories: on
                              ? row.policy.allowed_categories.filter((x) => x !== c)
                              : [...row.policy.allowed_categories, c],
                          })
                        }
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition ${
                          on
                            ? "bg-[#dff5ef] text-[#136456] border-[#b6e7dc]"
                            : "bg-white text-[#637181] border-[#dfe6ee]"
                        }`}
                      >
                        {c}
                      </button>
                    );
                  })}
                  {NEVER_AUTO.map((c) => (
                    <span
                      key={c}
                      title="Never auto-executed — hardcoded safety rule"
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold bg-[#ffe5e5] text-[#8c3340] border border-[#f1bfc5] cursor-not-allowed"
                    >
                      <ShieldCheck className="w-3.5 h-3.5" /> {c} · human only
                    </span>
                  ))}
                </div>
              </div>

              <button
                onClick={() => savePolicy(row)}
                disabled={savingId === row.merchant.id}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#12304a] hover:bg-[#164b66] text-white text-xs font-bold transition disabled:opacity-50"
              >
                {savingId === row.merchant.id ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Save className="w-3.5 h-3.5" />
                )}
                Save policy
              </button>
            </section>
          ))
        )}
      </main>
    </div>
  );
}
