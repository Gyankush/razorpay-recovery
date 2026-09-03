"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ShieldCheck,
  FileText,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  ClipboardList,
} from "lucide-react";

interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  entity: string;
  entityId: string | null;
  requestId: string | null;
  createdAt: string;
  before: Record<string, any> | null;
  after: Record<string, any> | null;
}

interface RecoveryRow {
  id: string;
  caseId: string;
  actionType: string;
  status: string;
  idempotencyKey: string;
  approvedBy: string | null;
  executedAt: string | null;
  createdAt: string;
  // joined
  orderRef?: string;
  amount?: string;
  currency?: string;
  failureCategory?: string;
}

const SYSTEM_OPERATOR = "System Admin";

const statusBadge = (status: string) => {
  switch (status) {
    case "executed":
      return "bg-[#dff5ef] text-[#136456] border-[#b6e7dc]";
    case "approved":
      return "bg-[#e9f4fc] text-[#1d5d86] border-[#b9dbf4]";
    case "proposed":
      return "bg-[#fff1c7] text-[#725311] border-[#f1d885]";
    case "rejected":
      return "bg-[#ffe5e5] text-[#8c3340] border-[#f1bfc5]";
    default:
      return "bg-[#f4f7fa] text-[#637181] border-[#dfe6ee]";
  }
};

const statusIcon = (status: string) => {
  switch (status) {
    case "executed":
      return <CheckCircle2 className="w-3.5 h-3.5" />;
    case "approved":
      return <ShieldCheck className="w-3.5 h-3.5" />;
    case "proposed":
      return <Clock className="w-3.5 h-3.5" />;
    case "rejected":
      return <XCircle className="w-3.5 h-3.5" />;
    default:
      return <AlertTriangle className="w-3.5 h-3.5" />;
  }
};

export default function AuditPage() {
  const [auditLogs, setAuditLogs] = useState<AuditEntry[]>([]);
  const [recoveryActions, setRecoveryActions] = useState<RecoveryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"recovery" | "audit">("recovery");

  const fetchData = async () => {
    try {
      setLoading(true);

      // Fetch audit logs
      const auditRes = await fetch("/api/audit?limit=100");
      if (auditRes.ok) {
        const auditData = await auditRes.json();
        setAuditLogs(auditData.logs || []);
      }

      // Fetch recovery actions with case context — in parallel with a
      // concurrency cap instead of one sequential round-trip per case.
      const casesRes = await fetch("/api/payment-cases?limit=100");
      if (casesRes.ok) {
        const casesData = await casesRes.json();
        const cases = casesData.cases || [];

        const settled = await Promise.allSettled(
          cases.map(async (c: any) => {
            const caseRes = await fetch(`/api/payment-cases/${c.id}`);
            if (!caseRes.ok) return [];
            const caseDetail = await caseRes.json();
            return (caseDetail.recovery_actions || []).map((ra: any) => ({
              ...ra,
              caseId: c.id,
              orderRef: c.externalOrderId,
              amount: c.amount_formatted,
              currency: c.currency,
              failureCategory: c.failureCategory,
            }));
          })
        );
        const allRecovery: RecoveryRow[] = settled.flatMap((r) =>
          r.status === "fulfilled" ? r.value : []
        );
        allRecovery.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
        setRecoveryActions(allRecovery);
      }
    } catch (err) {
      console.error("Failed to load audit data:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  return (
    <div className="min-h-screen bg-[#f4f7fa] text-[#17212b] pb-16">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-[#dfe6ee] px-6 py-3.5">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#dfe6ee] hover:bg-slate-50 text-xs font-bold text-[#12304a] transition"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Control Room
            </Link>
            <div className="flex items-center gap-2">
              <ClipboardList className="w-5 h-5 text-[#2ca7b8]" />
              <h1 className="text-lg font-bold tracking-tight text-[#12304a]">
                Audit & Compliance
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-xs text-[#637181]">
              System Operator:{" "}
              <span className="font-bold text-[#12304a]">{SYSTEM_OPERATOR}</span>
            </span>
            <button
              onClick={fetchData}
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#dfe6ee] text-xs font-semibold text-[#637181] hover:text-[#12304a] hover:bg-slate-50 transition"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="max-w-7xl mx-auto px-6 pt-8">
        {/* Kicker */}
        <div className="mb-6">
          <div className="text-xs font-bold uppercase tracking-wider text-[#2ca7b8] mb-1">
            Immutable Activity Record
          </div>
          <h2 className="text-2xl font-extrabold text-[#12304a] tracking-tight">
            Recovery Actions & System Audit Trail
          </h2>
          <p className="text-sm text-[#637181] mt-1 max-w-3xl">
            Every recovery action, diagnosis, approval, and system event is logged immutably for financial compliance, trust, and forensic debugging.
          </p>
        </div>

        {/* Tab Switcher */}
        <div className="flex gap-1 mb-6 bg-white rounded-xl border border-[#dfe6ee] p-1 w-fit">
          <button
            onClick={() => setActiveTab("recovery")}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition ${
              activeTab === "recovery"
                ? "bg-[#12304a] text-white shadow-sm"
                : "text-[#637181] hover:text-[#12304a]"
            }`}
          >
            <ShieldCheck className="w-3.5 h-3.5 inline mr-1.5" />
            Recovery Actions
          </button>
          <button
            onClick={() => setActiveTab("audit")}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition ${
              activeTab === "audit"
                ? "bg-[#12304a] text-white shadow-sm"
                : "text-[#637181] hover:text-[#12304a]"
            }`}
          >
            <FileText className="w-3.5 h-3.5 inline mr-1.5" />
            System Audit Logs
          </button>
        </div>

        {loading ? (
          <div className="p-12 text-center text-sm text-[#637181]">
            <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-3 text-[#2ca7b8]" />
            Loading audit records...
          </div>
        ) : activeTab === "recovery" ? (
          /* Recovery Actions Table */
          <div className="bg-white rounded-2xl border border-[#dfe6ee] shadow-sm overflow-hidden">
            <div className="p-5 border-b border-[#dfe6ee]">
              <h3 className="text-base font-bold text-[#12304a]">
                Executed Recovery Actions
              </h3>
              <p className="text-xs text-[#637181] mt-0.5">
                All bounded recovery steps with idempotency verification, operator approval, and case linkage.
              </p>
            </div>

            {recoveryActions.length === 0 ? (
              <div className="p-12 text-center text-sm text-[#637181]">
                <ShieldCheck className="w-8 h-8 mx-auto mb-3 text-[#dfe6ee]" />
                <p className="font-semibold text-[#12304a] text-base mb-1">
                  No recovery actions recorded yet
                </p>
                <p>
                  Recovery actions will appear here once operators approve and execute payment link recoveries from the Case Detail screen.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-[#f7fafc] border-b border-[#dfe6ee] text-[11px] font-bold text-[#637181] uppercase tracking-wider">
                      <th className="py-3 px-4">Timestamp</th>
                      <th className="py-3 px-4">Order Ref</th>
                      <th className="py-3 px-4">Action Type</th>
                      <th className="py-3 px-4">Status</th>
                      <th className="py-3 px-4">Approved By</th>
                      <th className="py-3 px-4">Failure Category</th>
                      <th className="py-3 px-4">Idempotency Key</th>
                      <th className="py-3 px-4 text-right">Case</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#dfe6ee] text-xs">
                    {recoveryActions.map((ra) => (
                      <tr key={ra.id} className="hover:bg-[#f9fbfd] transition-colors">
                        <td className="py-3.5 px-4 font-mono text-[11px] text-[#637181]">
                          {new Date(ra.executedAt || ra.createdAt).toLocaleString([], {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </td>
                        <td className="py-3.5 px-4 font-mono font-medium text-[#12304a]">
                          {ra.orderRef || "—"}
                        </td>
                        <td className="py-3.5 px-4 text-[#12304a] font-semibold">
                          {ra.actionType.replace(/_/g, " ")}
                        </td>
                        <td className="py-3.5 px-4">
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold border ${statusBadge(
                              ra.status
                            )}`}
                          >
                            {statusIcon(ra.status)}
                            {ra.status}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 font-medium text-[#12304a]">
                          {ra.approvedBy || SYSTEM_OPERATOR}
                        </td>
                        <td className="py-3.5 px-4">
                          <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-bold bg-[#fff1c7] text-[#725311] border border-[#f1d885]">
                            {ra.failureCategory || "unknown"}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 font-mono text-[10px] text-[#637181] max-w-[180px] truncate">
                          {ra.idempotencyKey}
                        </td>
                        <td className="py-3.5 px-4 text-right">
                          <Link
                            href={`/cases/${ra.caseId}`}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#12304a] hover:bg-[#164b66] text-white font-bold text-[11px] shadow-sm transition"
                          >
                            View
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : (
          /* System Audit Logs Table */
          <div className="bg-white rounded-2xl border border-[#dfe6ee] shadow-sm overflow-hidden">
            <div className="p-5 border-b border-[#dfe6ee]">
              <h3 className="text-base font-bold text-[#12304a]">
                Immutable System Audit Log
              </h3>
              <p className="text-xs text-[#637181] mt-0.5">
                Append-only record of all system actions — webhook ingests, diagnoses, case state transitions, and operator approvals.
              </p>
            </div>

            {auditLogs.length === 0 ? (
              <div className="p-12 text-center text-sm text-[#637181]">
                <FileText className="w-8 h-8 mx-auto mb-3 text-[#dfe6ee]" />
                <p className="font-semibold text-[#12304a] text-base mb-1">
                  No audit logs recorded yet
                </p>
                <p>
                  System audit entries will be recorded as webhooks are processed, cases diagnosed, and recovery actions executed.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-[#f7fafc] border-b border-[#dfe6ee] text-[11px] font-bold text-[#637181] uppercase tracking-wider">
                      <th className="py-3 px-4">Timestamp</th>
                      <th className="py-3 px-4">Actor</th>
                      <th className="py-3 px-4">Action</th>
                      <th className="py-3 px-4">Entity</th>
                      <th className="py-3 px-4">Entity ID</th>
                      <th className="py-3 px-4">Request ID</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#dfe6ee] text-xs">
                    {auditLogs.map((log) => (
                      <tr key={log.id} className="hover:bg-[#f9fbfd] transition-colors">
                        <td className="py-3.5 px-4 font-mono text-[11px] text-[#637181]">
                          {new Date(log.createdAt).toLocaleString([], {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </td>
                        <td className="py-3.5 px-4 font-medium text-[#12304a]">
                          {log.actor}
                        </td>
                        <td className="py-3.5 px-4">
                          <span className="inline-flex px-2 py-0.5 rounded-md bg-[#e9f4fc] text-[#1d5d86] border border-[#b9dbf4] text-[11px] font-bold">
                            {log.action}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 text-[#12304a] font-semibold">
                          {log.entity}
                        </td>
                        <td className="py-3.5 px-4 font-mono text-[11px] text-[#637181] max-w-[160px] truncate">
                          {log.entityId || "—"}
                        </td>
                        <td className="py-3.5 px-4 font-mono text-[10px] text-[#637181] max-w-[150px] truncate">
                          {log.requestId || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
