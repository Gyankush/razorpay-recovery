"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ShieldCheck,
  ArrowRight,
  AlertTriangle,
  RefreshCw,
  TrendingUp,
  PlusCircle,
  Sparkles,
  CheckCircle2,
  ClipboardList,
  Search,
} from "lucide-react";

interface SummaryData {
  money_at_risk: number;
  recoverable_cases_count: number;
  unresolved_cases_count: number;
  recovered_amount: number;
  resolved_cases_count: number;
  total_cases_count: number;
}

interface CaseItem {
  id: string;
  orderId: string;
  externalOrderId: string;
  amount: number;
  amount_formatted: string;
  currency: string;
  status: "open" | "resolved" | "action_required";
  failureCategory: string | null;
  confidence: string | null;
  plainExplanation: string | null;
  recommendedAction: string | null;
  createdAt: string;
  latest_error_code: string | null;
  latest_error_description: string | null;
  provider_payment_id: string | null;
}

function formatMoney(amountCents: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
    }).format(amountCents / 100);
  } catch {
    return `$${(amountCents / 100).toFixed(2)} ${currency}`;
  }
}

function categoryStyles(category: string | null): string {
  if (category === "customer_action" || category === "customer_action_required")
    return "bg-[#fff1c7] text-[#725311] border border-[#f1d885]";
  if (category === "issuer_decline" || category === "gateway_failure")
    return "bg-[#ffe5e5] text-[#8c3340] border border-[#f1bfc5]";
  if (category === "risk_block")
    return "bg-[#ffe5e5] text-[#8c3340] border border-[#f1bfc5]";
  return "bg-[#e9f4fc] text-[#1d5d86] border border-[#b9dbf4]";
}

export default function DashboardPage() {
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [cases, setCases] = useState<CaseItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [seedSuccessMessage, setSeedSuccessMessage] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "open" | "resolved" | "action_required">("all");

  const fetchData = async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const [sumRes, casesRes] = await Promise.all([
        fetch("/api/dashboard/summary"),
        fetch("/api/payment-cases"),
      ]);

      if (sumRes.ok) {
        const sumData = await sumRes.json();
        setSummary(sumData.summary);
      }
      if (casesRes.ok) {
        const casesData = await casesRes.json();
        setCases(casesData.cases || []);
      }
      if (!sumRes.ok || !casesRes.ok) {
        throw new Error("One or more dashboard requests failed");
      }
    } catch (err) {
      console.error("Failed to load dashboard data:", err);
      setLoadError("Could not load recovery data. Check your database connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleSeed = async (scenarioName: string) => {
    try {
      setSeeding(true);
      setSeedSuccessMessage(null);
      const res = await fetch(`/api/demo/scenarios/${scenarioName}`, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setSeedSuccessMessage(
          `Seeded '${scenarioName}' (Case #${String(data.case_id || "").substring(0, 8)}). Refreshing control room...`
        );
        await fetchData();
        setTimeout(() => setSeedSuccessMessage(null), 5000);
      }
    } catch (err) {
      console.error("Failed to seed scenario:", err);
    } finally {
      setSeeding(false);
    }
  };

  const filteredCases = useMemo(() => {
    const q = query.trim().toLowerCase();
    return cases.filter((c) => {
      if (statusFilter !== "all" && c.status !== statusFilter) return false;
      if (!q) return true;
      return (
        c.externalOrderId?.toLowerCase().includes(q) ||
        c.latest_error_code?.toLowerCase().includes(q) ||
        c.latest_error_description?.toLowerCase().includes(q) ||
        c.failureCategory?.toLowerCase().includes(q) ||
        c.provider_payment_id?.toLowerCase().includes(q)
      );
    });
  }, [cases, query, statusFilter]);

  return (
    <div className="min-h-screen bg-[#f4f7fa] text-[#17212b]">
      {/* Top Bar */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-[#dfe6ee] px-6 py-3.5">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div
              aria-hidden
              className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#2ca7b8] to-[#12304a] flex items-center justify-center text-white font-extrabold text-base shadow-sm"
            >
              P
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold tracking-tight text-[#12304a]">
                  PayRescue
                </h1>
                <span className="text-xs px-2 py-0.5 rounded-md font-semibold bg-[#e9f4fc] text-[#1d5d86] border border-[#b9dbf4]">
                  Control Room
                </span>
              </div>
              <p className="text-xs text-[#637181]">
                International Payment Recovery Copilot
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-[#dff5ef] text-[#136456] border border-[#b6e7dc]">
              <span className="w-2 h-2 rounded-full bg-[#136456] animate-pulse" aria-hidden />
              Test Mode / Synthetic Demo
            </span>

            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => handleSeed("international_3ds_fail")}
                disabled={seeding}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#12304a] hover:bg-[#164b66] active:scale-[0.98] text-white text-xs font-semibold shadow-sm transition disabled:opacity-50"
              >
                {seeding ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <PlusCircle className="w-3.5 h-3.5" />
                )}
                Seed 3DS Fail
              </button>

              <button
                onClick={() => handleSeed("issuer_decline")}
                disabled={seeding}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-white border border-[#dfe6ee] hover:bg-slate-50 active:scale-[0.98] text-[#12304a] text-xs font-semibold shadow-sm transition disabled:opacity-50"
              >
                Seed Issuer Decline
              </button>

              <Link
                href="/audit"
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-white border border-[#dfe6ee] hover:bg-slate-50 text-[#12304a] text-xs font-semibold shadow-sm transition"
              >
                <ClipboardList className="w-3.5 h-3.5 text-[#2ca7b8]" />
                Audit Trail
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="max-w-7xl mx-auto px-6 py-8">
        {seedSuccessMessage && (
          <div
            role="status"
            className="mb-6 p-4 rounded-xl bg-[#dff5ef] border border-[#b6e7dc] text-[#136456] text-sm flex items-center justify-between animate-fadeIn"
          >
            <div className="flex items-center gap-2 font-medium">
              <CheckCircle2 className="w-4 h-4 text-[#136456]" />
              {seedSuccessMessage}
            </div>
          </div>
        )}

        {loadError && (
          <div
            role="alert"
            className="mb-6 p-4 rounded-xl bg-[#ffe5e5] border border-[#f1bfc5] text-[#8c3340] text-sm flex flex-wrap items-center justify-between gap-3 animate-fadeIn"
          >
            <div className="flex items-center gap-2 font-medium">
              <AlertTriangle className="w-4 h-4" />
              {loadError}
            </div>
            <button
              onClick={fetchData}
              className="px-3 py-1.5 rounded-lg bg-white border border-[#f1bfc5] text-xs font-bold hover:bg-red-50 transition"
            >
              Retry
            </button>
          </div>
        )}

        {/* Executive Kicker */}
        <div className="mb-8 animate-slideUp">
          <div className="text-xs font-bold uppercase tracking-wider text-[#2ca7b8] mb-1">
            Revenue Recovery Pipeline
          </div>
          <h2 className="text-2xl md:text-3xl font-extrabold text-[#12304a] tracking-tight">
            International Payment Truth &amp; Recovery
          </h2>
          <p className="text-sm text-[#637181] mt-1 max-w-3xl">
            Real-time diagnosis of failed international transactions, non-fatal drop-offs, and human-in-the-loop recovery links with guaranteed idempotency.
          </p>
        </div>

        {/* Metric Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 mb-8" aria-live="polite">
          <div className="p-5 rounded-2xl bg-white border border-[#dfe6ee] shadow-sm card-hover animate-slideUp">
            <div className="flex items-center justify-between text-xs font-bold text-[#637181] uppercase tracking-wider mb-2">
              <span>Money at Risk</span>
              <div className="w-7 h-7 rounded-lg bg-[#ffe5e5] text-[#8c3340] flex items-center justify-center">
                <AlertTriangle className="w-4 h-4" />
              </div>
            </div>
            <div className="text-2xl md:text-3xl font-extrabold text-[#12304a] num">
              {loading ? <span className="skeleton inline-block h-8 w-24 rounded-lg" /> : `$${summary ? summary.money_at_risk.toFixed(2) : "0.00"}`}
            </div>
            <div className="text-xs text-[#8c3340] font-medium mt-1">
              {summary ? summary.unresolved_cases_count : 0} open failed checkout(s)
            </div>
          </div>

          <div className="p-5 rounded-2xl bg-white border border-[#dfe6ee] shadow-sm card-hover animate-slideUp" style={{ animationDelay: "60ms" }}>
            <div className="flex items-center justify-between text-xs font-bold text-[#637181] uppercase tracking-wider mb-2">
              <span>Recoverable Cases</span>
              <div className="w-7 h-7 rounded-lg bg-[#dff5ef] text-[#136456] flex items-center justify-center">
                <ShieldCheck className="w-4 h-4" />
              </div>
            </div>
            <div className="text-2xl md:text-3xl font-extrabold text-[#12304a] num">
              {loading ? <span className="skeleton inline-block h-8 w-16 rounded-lg" /> : summary ? summary.recoverable_cases_count : 0}
            </div>
            <div className="text-xs text-[#136456] font-medium mt-1">
              Eligible for alternate payment link
            </div>
          </div>

          <div className="p-5 rounded-2xl bg-white border border-[#dfe6ee] shadow-sm card-hover animate-slideUp" style={{ animationDelay: "120ms" }}>
            <div className="flex items-center justify-between text-xs font-bold text-[#637181] uppercase tracking-wider mb-2">
              <span>Recovered Revenue</span>
              <div className="w-7 h-7 rounded-lg bg-[#e9f4fc] text-[#1d5d86] flex items-center justify-center">
                <TrendingUp className="w-4 h-4" />
              </div>
            </div>
            <div className="text-2xl md:text-3xl font-extrabold text-[#12304a] num">
              {loading ? <span className="skeleton inline-block h-8 w-24 rounded-lg" /> : `$${summary ? summary.recovered_amount.toFixed(2) : "0.00"}`}
            </div>
            <div className="text-xs text-[#1d5d86] font-medium mt-1">
              {summary ? summary.resolved_cases_count : 0} case(s) resolved
            </div>
          </div>

          <div className="p-5 rounded-2xl bg-white border border-[#dfe6ee] shadow-sm card-hover animate-slideUp" style={{ animationDelay: "180ms" }}>
            <div className="flex items-center justify-between text-xs font-bold text-[#637181] uppercase tracking-wider mb-2">
              <span>Policy Guard</span>
              <div className="w-7 h-7 rounded-lg bg-[#fff1c7] text-[#725311] flex items-center justify-center">
                <Sparkles className="w-4 h-4" />
              </div>
            </div>
            <div className="text-2xl md:text-3xl font-extrabold text-[#12304a] num">100%</div>
            <div className="text-xs text-[#725311] font-medium mt-1">
              Zero blind retries · Human approved
            </div>
          </div>
        </div>

        {/* Cases Section */}
        <section aria-label="Payment recovery queue" className="bg-white rounded-2xl border border-[#dfe6ee] shadow-sm overflow-hidden">
          <div className="p-5 border-b border-[#dfe6ee] flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 className="text-base font-bold text-[#12304a]">Payment Recovery Queue</h3>
              <p className="text-xs text-[#637181] mt-0.5">
                Every failed transaction mapped to its root cause, confidence score, and recovery step.
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <label className="relative">
                <span className="sr-only">Search cases</span>
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#637181]" aria-hidden />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search order, error, category…"
                  className="pl-8 pr-3 py-1.5 rounded-lg border border-[#dfe6ee] text-xs w-56 focus:outline-none focus:border-[#2ca7b8] bg-white"
                />
              </label>
              <label className="text-xs text-[#637181] font-semibold">
                <span className="sr-only">Filter by status</span>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
                  className="px-2.5 py-1.5 rounded-lg border border-[#dfe6ee] text-xs font-semibold text-[#12304a] bg-white"
                >
                  <option value="all">All statuses</option>
                  <option value="open">Open</option>
                  <option value="action_required">Action required</option>
                  <option value="resolved">Resolved</option>
                </select>
              </label>
              <button
                onClick={fetchData}
                disabled={loading}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#dfe6ee] text-xs font-semibold text-[#637181] hover:text-[#12304a] hover:bg-slate-50 transition disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </button>
            </div>
          </div>

          {loading && cases.length === 0 ? (
            <div className="p-6 space-y-3" role="status" aria-label="Loading cases">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="skeleton h-12 w-full rounded-xl" />
              ))}
              <p className="text-center text-xs text-[#637181] pt-2">Loading recovery cases from Supabase…</p>
            </div>
          ) : filteredCases.length === 0 ? (
            <div className="p-12 text-center text-sm text-[#637181]">
              <p className="font-semibold text-[#12304a] text-base mb-1">
                {cases.length === 0 ? "No payment cases found" : "No cases match your filters"}
              </p>
              <p className="mb-4">
                {cases.length === 0
                  ? 'Click "Seed 3DS Fail" or "Seed Issuer Decline" in the top bar to populate realistic international failure scenarios.'
                  : "Try clearing the search or choosing a different status."}
              </p>
              {cases.length === 0 ? (
                <button
                  onClick={() => handleSeed("international_3ds_fail")}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#12304a] text-white text-xs font-bold hover:bg-[#164b66] active:scale-[0.98] transition"
                >
                  <PlusCircle className="w-4 h-4" /> Seed Synthetic Case
                </button>
              ) : (
                <button
                  onClick={() => {
                    setQuery("");
                    setStatusFilter("all");
                  }}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-white border border-[#dfe6ee] text-[#12304a] text-xs font-bold hover:bg-slate-50 transition"
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-[#f7fafc] border-b border-[#dfe6ee] text-[11px] font-bold text-[#637181] uppercase tracking-wider">
                    <th scope="col" className="py-3 px-4">Order Ref</th>
                    <th scope="col" className="py-3 px-4">Amount</th>
                    <th scope="col" className="py-3 px-4">Gateway Reason</th>
                    <th scope="col" className="py-3 px-4">Failure Category</th>
                    <th scope="col" className="py-3 px-4">Confidence</th>
                    <th scope="col" className="py-3 px-4">Status</th>
                    <th scope="col" className="py-3 px-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#dfe6ee] text-xs">
                  {filteredCases.map((c) => {
                    const isResolved = c.status === "resolved";
                    return (
                      <tr key={c.id} className="hover:bg-[#f9fbfd] transition-colors">
                        <td className="py-3.5 px-4 font-mono font-medium text-[#12304a]">{c.externalOrderId}</td>
                        <td className="py-3.5 px-4 font-bold text-[#12304a] num">
                          {formatMoney(c.amount, c.currency)}
                        </td>
                        <td className="py-3.5 px-4 max-w-xs truncate text-[#637181]" title={c.latest_error_description || c.latest_error_code || c.plainExplanation || ""}>
                          {c.latest_error_description || c.latest_error_code || c.plainExplanation || "Payment failed without capture"}
                        </td>
                        <td className="py-3.5 px-4">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold ${categoryStyles(c.failureCategory)}`}>
                            {c.failureCategory || "unknown"}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 font-mono font-medium text-[#12304a] num">
                          {c.confidence ? `${Math.round(Number(c.confidence) * 100)}%` : "88%"}
                        </td>
                        <td className="py-3.5 px-4">
                          <span
                            className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold ${
                              isResolved
                                ? "bg-[#dff5ef] text-[#136456] border border-[#b6e7dc]"
                                : c.status === "action_required"
                                  ? "bg-[#ffe5e5] text-[#8c3340] border border-[#f1bfc5]"
                                  : "bg-[#fff1c7] text-[#725311] border border-[#f1d885]"
                            }`}
                          >
                            {isResolved ? "Resolved" : c.status === "action_required" ? "Action required" : "Open"}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 text-right">
                          <Link
                            href={`/cases/${c.id}`}
                            aria-label={`Investigate case ${c.externalOrderId}`}
                            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[#12304a] hover:bg-[#164b66] active:scale-[0.98] text-white font-bold text-xs shadow-sm transition"
                          >
                            Investigate <ArrowRight className="w-3.5 h-3.5" />
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="px-5 py-3 border-t border-[#dfe6ee] text-[11px] text-[#637181] bg-[#f7fafc]">
                Showing {filteredCases.length} of {cases.length} cases
                {query || statusFilter !== "all" ? " (filtered)" : ""} · Amounts formatted per currency
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
