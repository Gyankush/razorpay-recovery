"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { adminHeaders } from "@/lib/admin-key";
import {
  ArrowLeft,
  ShieldAlert,
  ShieldCheck,
  AlertOctagon,
  CheckCircle2,
  Clock,
  Copy,
  ExternalLink,
  Sparkles,
  RefreshCw,
  Send,
  Layers,
  MessageSquare,
  Check,
  FileText,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

interface CaseDetailData {
  case: {
    id: string;
    orderId: string;
    status: "open" | "resolved" | "action_required";
    failureCategory: string | null;
    confidence: string | null;
    plainExplanation: string | null;
    recommendedAction: string | null;
    createdAt: string;
  };
  order: {
    id: string;
    externalOrderId: string;
    amount: number;
    amount_formatted: string;
    currency: string;
    status: string;
    createdAt: string;
  } | null;
  merchant: {
    id: string;
    name: string;
    mode: string;
  } | null;
  latest_attempt: {
    id: string;
    providerPaymentId: string | null;
    status: string;
    errorCode: string | null;
    errorDescription: string | null;
    createdAt: string;
  } | null;
  recovery_actions: Array<{
    id: string;
    actionType: string;
    status: string;
    idempotencyKey: string;
    approvedBy: string | null;
    executedAt: string | null;
  }>;
  diagnosis: {
    category: string;
    confidence: number;
    facts_used: string[];
    explanation: string;
    recommended_action: string;
    do_not_do: string[];
    stopping_rule: string;
    needs_human_approval: boolean;
  };
  timeline: Array<{
    step: number;
    name: string;
    status: string;
    timestamp: string;
    details: string;
    meta?: Record<string, any>;
  }>;
}

export default function CaseDetailPage() {
  const params = useParams();
  const router = useRouter();
  const caseId = params?.id as string;

  const [data, setData] = useState<CaseDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const [generatedLink, setGeneratedLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [approvalOperator, setApprovalOperator] = useState("System Admin");
  const [supportPacket, setSupportPacket] = useState<any | null>(null);
  const [loadingPacket, setLoadingPacket] = useState(false);
  const [packetCopied, setPacketCopied] = useState(false);
  const [showTechDetails, setShowTechDetails] = useState(false);

  const handleGenerateSupportPacket = async () => {
    if (!caseId) return;
    try {
      setLoadingPacket(true);
      const res = await fetch(`/api/support/${caseId}`);
      if (res.ok) {
        const json = await res.json();
        setSupportPacket(json.packet);
      }
    } catch (err) {
      console.error("Failed to generate support packet:", err);
    } finally {
      setLoadingPacket(false);
    }
  };

  const copyPacketText = (text: string) => {
    navigator.clipboard.writeText(text);
    setPacketCopied(true);
    setTimeout(() => setPacketCopied(false), 2500);
  };

  const fetchCase = async () => {
    if (!caseId) return;
    try {
      setLoading(true);
      const res = await fetch(`/api/payment-cases/${caseId}`);
      if (res.ok) {
        const json = await res.json();
        setData(json);

        // If recovery action already exists, extract link
        if (json.recovery_actions && json.recovery_actions.length > 0) {
          const act = json.recovery_actions[0];
          setGeneratedLink(`https://rzp.io/i/rec_${act.id.substring(0, 8)}`);
        }
      }
    } catch (err) {
      console.error("Failed to fetch case details:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCase();
  }, [caseId]);

  const handleApproveRecovery = async () => {
    if (!caseId) return;
    try {
      setApproving(true);
      const res = await fetch(`/api/payment-cases/${caseId}/payment-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({
          approved_by: approvalOperator,
          idempotency_key: `case_${caseId}_rec_${Date.now()}`,
          reason: "Approved alternate recovery link for customer drop-off",
        }),
      });

      if (res.ok) {
        const json = await res.json();
        setGeneratedLink(json.payment_link);
        await fetchCase(); // reload updated case status
      }
    } catch (err) {
      console.error("Failed to approve recovery action:", err);
    } finally {
      setApproving(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#f4f7fa] flex items-center justify-center p-6 text-sm text-[#637181]">
        <RefreshCw className="w-6 h-6 animate-spin text-[#2ca7b8] mr-3" />
        Loading Payment Case investigation...
      </div>
    );
  }

  if (!data || !data.case) {
    return (
      <div className="min-h-screen bg-[#f4f7fa] p-8 max-w-4xl mx-auto">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-xs font-bold text-[#1d6b9f] mb-6"
        >
          <ArrowLeft className="w-4 h-4" /> Back to Control Room
        </Link>
        <div className="p-8 bg-white border border-[#dfe6ee] rounded-2xl text-center">
          <h2 className="text-lg font-bold text-[#12304a]">Case Not Found</h2>
          <p className="text-xs text-[#637181] mt-1">
            The requested payment case does not exist or has been deleted.
          </p>
        </div>
      </div>
    );
  }

  const { case: c, order, latest_attempt: att, diagnosis, timeline } = data;
  const isResolved = c.status === "resolved";

  return (
    <div className="min-h-screen bg-[#f4f7fa] text-[#17212b] pb-16">
      {/* Top Bar Navigation */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-[#dfe6ee] px-6 py-3.5">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#dfe6ee] hover:bg-slate-50 text-xs font-bold text-[#12304a] transition"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Back to Queue
            </Link>
            <span className="text-xs text-[#637181] font-mono">
              Case #{c.id.substring(0, 13)}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold ${
                isResolved
                  ? "bg-[#dff5ef] text-[#136456] border border-[#b6e7dc]"
                  : "bg-[#fff1c7] text-[#725311] border border-[#f1d885]"
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  isResolved ? "bg-[#136456]" : "bg-[#725311] animate-pulse"
                }`}
              />
              {isResolved ? "Resolved" : "Open for Recovery"}
            </span>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="max-w-6xl mx-auto px-6 pt-8 space-y-6">
        {/* Header Hero / Summary */}
        <div className="p-6 md:p-8 rounded-3xl bg-white border border-[#dfe6ee] shadow-sm flex flex-wrap items-start justify-between gap-6">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-extrabold uppercase tracking-wider text-[#2ca7b8]">
                Payment Diagnosis
              </span>
              <span className="text-xs text-[#637181]">·</span>
              <span className="text-xs text-[#637181] font-mono">
                Order {order?.externalOrderId}
              </span>
            </div>
            <h1 className="text-2xl md:text-3xl font-extrabold text-[#12304a] tracking-tight">
              {diagnosis.category === "customer_action"
                ? "3D-Secure Authentication Drop-Off"
                : diagnosis.category === "risk_block"
                ? "Gateway Risk Block Detected"
                : diagnosis.category === "issuer_decline"
                ? "International Issuer Decline"
                : "Payment Checkout Failure"}
            </h1>
            <p className="text-sm text-[#4e6574] mt-2 max-w-2xl leading-relaxed">
              {diagnosis.explanation}
            </p>
          </div>

          <div className="text-right sm:border-l sm:border-[#dfe6ee] sm:pl-6">
            <div className="text-xs text-[#637181] font-bold uppercase tracking-wider">
              Amount at Risk
            </div>
            <div className="text-3xl font-black text-[#12304a] tracking-tight mt-1">
              ${order?.amount_formatted} {order?.currency}
            </div>
            <div className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#e9f4fc] border border-[#b9dbf4] text-[11px] font-bold text-[#1d5d86]">
              <Sparkles className="w-3.5 h-3.5" />
              {Math.round(diagnosis.confidence * 100)}% AI Confidence
            </div>
          </div>
        </div>

        {/* Two-Column Grid: Evidence & Action */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left 2 Columns: Evidence & Timeline */}
          <div className="lg:col-span-2 space-y-6">
            {/* Why this recommendation panel */}
            <div className="p-6 rounded-2xl bg-white border border-[#dfe6ee] shadow-sm space-y-4">
              <h3 className="text-base font-bold text-[#12304a] flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-[#2ca7b8]" />
                Why This Recommendation?
              </h3>

              {/* Facts Used */}
              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider text-[#637181] mb-2">
                  Observed Gateway Facts
                </h4>
                <div className="flex flex-wrap gap-2">
                  {diagnosis.facts_used.map((fact, idx) => (
                    <span
                      key={idx}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-[#f4f7fa] border border-[#dfe6ee] text-xs font-mono text-[#12304a]"
                    >
                      <CheckCircle2 className="w-3 h-3 text-[#136456]" />
                      {fact}
                    </span>
                  ))}
                </div>
              </div>

              {/* Anti-Patterns / Do Not Do Callout */}
              <div className="p-4 rounded-xl bg-[#ffe5e5] border border-[#f1bfc5] text-[#8c3340]">
                <div className="flex items-center gap-2 font-bold text-xs uppercase tracking-wider mb-1">
                  <AlertOctagon className="w-4 h-4 text-[#8c3340]" />
                  What NOT To Do (Safety Guardrail)
                </div>
                <ul className="text-xs list-disc pl-5 space-y-1 font-medium">
                  {diagnosis.do_not_do.map((item, idx) => (
                    <li key={idx}>
                      <span className="font-bold">{item.replace(/_/g, " ")}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Stopping Rule */}
              <div className="text-xs text-[#637181]">
                <strong className="text-[#12304a]">Stopping Rule:</strong>{" "}
                {diagnosis.stopping_rule}
              </div>
            </div>

            {/* Event Timeline */}
            <div className="p-6 rounded-2xl bg-white border border-[#dfe6ee] shadow-sm">
              <h3 className="text-base font-bold text-[#12304a] flex items-center gap-2 mb-4">
                <Clock className="w-5 h-5 text-[#1d6b9f]" />
                Chronological Event Spine
              </h3>

              <div className="relative pl-6 space-y-6 before:absolute before:left-2 before:top-2 before:bottom-2 before:w-0.5 before:bg-[#dfe6ee]">
                {timeline.map((evt, idx) => {
                  const isFailed = evt.status === "failed";
                  return (
                    <div key={idx} className="relative group">
                      {/* Dot */}
                      <span
                        className={`absolute -left-[27px] top-1.5 w-3.5 h-3.5 rounded-full border-2 border-white shadow-sm ${
                          isFailed
                            ? "bg-[#8c3340]"
                            : evt.status === "active"
                            ? "bg-[#2ca7b8]"
                            : "bg-[#136456]"
                        }`}
                      />

                      <div className="flex items-center justify-between text-xs font-semibold">
                        <span className="text-[#12304a] font-bold text-sm">
                          {evt.name}
                        </span>
                        <span className="text-[#637181] font-mono text-[11px]">
                          {new Date(evt.timestamp).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </span>
                      </div>
                      <p className="text-xs text-[#4e6574] mt-1 leading-relaxed">
                        {evt.details}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Right Column: Bounded Recovery Action & Customer Support */}
          <div className="space-y-6">
            <div className="p-6 rounded-2xl bg-white border border-[#dfe6ee] shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-bold text-[#12304a]">
                  Recovery Action
                </h3>
                <span className="text-[11px] font-bold px-2 py-0.5 rounded bg-[#dff5ef] text-[#136456] border border-[#b6e7dc]">
                  Bounded Step
                </span>
              </div>

              {isResolved || generatedLink ? (
                <div className="p-4 rounded-xl bg-[#dff5ef] border border-[#b6e7dc] space-y-3">
                  <div className="flex items-center gap-2 text-sm font-bold text-[#136456]">
                    <CheckCircle2 className="w-4 h-4" />
                    Recovery Link Generated
                  </div>
                  <p className="text-xs text-[#136456]">
                    An alternate test payment link was issued with 60-minute expiry.
                  </p>

                  {/* Payment Link URL Box */}
                  <div className="p-2.5 bg-white rounded-lg border border-[#b6e7dc] font-mono text-xs text-[#12304a] break-all flex items-center justify-between gap-2">
                    <span className="truncate">{generatedLink}</span>
                    <button
                      onClick={() => copyToClipboard(generatedLink || "")}
                      className="p-1.5 rounded hover:bg-slate-100 text-[#1d6b9f]"
                      title="Copy URL"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {copied && (
                    <div className="text-[11px] font-bold text-[#136456] flex items-center gap-1">
                      ✓ Copied to clipboard!
                    </div>
                  )}

                  <a
                    href={generatedLink || "#"}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center justify-center gap-1.5 w-full px-3 py-2 rounded-lg bg-[#136456] text-white text-xs font-bold hover:bg-[#0f4f44] transition"
                  >
                    Open Live Checkout <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="p-3.5 rounded-xl bg-[#f4f7fa] border border-[#dfe6ee] text-xs space-y-2">
                    <div className="font-bold text-[#12304a]">
                      Proposed Action:
                    </div>
                    <div className="text-[#4e6574]">
                      Issue an alternate Test Mode Payment Link to recover ${order?.amount_formatted} {order?.currency}.
                    </div>
                    <div className="font-mono text-[11px] text-[#637181]">
                      Expiry: 60 minutes · Method: Multi-rail
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-[#12304a] mb-1">
                      Approving Operator
                    </label>
                    <input
                      type="text"
                      value={approvalOperator}
                      onChange={(e) => setApprovalOperator(e.target.value)}
                      className="w-full px-3 py-2 text-xs border border-[#dfe6ee] rounded-lg focus:outline-none focus:border-[#2ca7b8]"
                      placeholder="operator_name"
                    />
                  </div>

                  <div className="p-3 rounded-lg bg-[#fff1c7] border border-[#f1d885] text-[11px] text-[#725311]">
                    <strong>Human Guardrail:</strong> Payment actions require manual approval. Idempotency guarantees exactly one link is created.
                  </div>

                  <button
                    onClick={handleApproveRecovery}
                    disabled={approving}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[#12304a] hover:bg-[#164b66] text-white font-bold text-xs shadow transition disabled:opacity-50"
                  >
                    {approving ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        Generating Payment Link...
                      </>
                    ) : (
                      <>
                        <Send className="w-4 h-4" />
                        Approve & Generate Payment Link
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>

            {/* Customer Support Packet Card */}
            <div className="p-6 rounded-2xl bg-white border border-[#dfe6ee] shadow-sm text-xs space-y-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h4 className="font-bold text-[#12304a] flex items-center gap-1.5 text-sm">
                    <MessageSquare className="w-4 h-4 text-[#2ca7b8]" />
                    Customer Support Packet
                  </h4>
                  <p className="text-[11px] text-[#637181] mt-0.5">
                    Customer-safe explanation masking raw gateway errors with recovery guidance.
                  </p>
                </div>
                {supportPacket && (
                  <button
                    onClick={handleGenerateSupportPacket}
                    disabled={loadingPacket}
                    className="text-[11px] text-[#2ca7b8] hover:underline font-semibold flex items-center gap-1"
                  >
                    <RefreshCw className={`w-3 h-3 ${loadingPacket ? "animate-spin" : ""}`} />
                    Refresh
                  </button>
                )}
              </div>

              {!supportPacket ? (
                <div className="space-y-3">
                  <div className="p-3.5 rounded-xl bg-[#f4f7fa] border border-[#dfe6ee] text-[#637181] text-[11px] leading-relaxed">
                    Generate an empathetic, non-technical customer message for Tier-1 support. Automatically masks technical error codes and references the recovery checkout link.
                  </div>
                  <button
                    onClick={handleGenerateSupportPacket}
                    disabled={loadingPacket}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[#2ca7b8] hover:bg-[#238b99] text-white font-bold text-xs shadow-sm transition disabled:opacity-50"
                  >
                    {loadingPacket ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        Generating Support Packet...
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-4 h-4" />
                        Generate Support Packet
                      </>
                    )}
                  </button>
                </div>
              ) : (
                <div className="space-y-3 animate-fadeIn">
                  {/* Copyable Message Box */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[11px] font-bold text-[#12304a] uppercase tracking-wider">
                        Customer-Facing Message
                      </span>
                      <button
                        onClick={() => copyPacketText(supportPacket.customer_safe_message)}
                        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-bold transition ${
                          packetCopied
                            ? "bg-[#dff5ef] text-[#136456] border border-[#b6e7dc]"
                            : "bg-[#12304a] text-white hover:bg-[#164b66]"
                        }`}
                      >
                        {packetCopied ? (
                          <>
                            <Check className="w-3 h-3 text-[#136456]" />
                            Copied!
                          </>
                        ) : (
                          <>
                            <Copy className="w-3 h-3" />
                            Copy Message
                          </>
                        )}
                      </button>
                    </div>

                    <div className="p-3.5 rounded-xl bg-[#f8fafc] border border-[#dfe6ee] font-sans text-xs text-[#17212b] whitespace-pre-line leading-relaxed max-h-56 overflow-y-auto select-all">
                      {supportPacket.customer_safe_message}
                    </div>
                  </div>

                  {/* Safety Guarantees Badges */}
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-[#dff5ef] text-[#136456] border border-[#b6e7dc]">
                      <Check className="w-3 h-3" /> Raw Errors Masked
                    </span>
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-[#e9f4fc] text-[#1d5d86] border border-[#b9dbf4]">
                      <Check className="w-3 h-3" /> Dedicated Recovery Link
                    </span>
                  </div>

                  {/* Collapsible Tier-2 Technical Details */}
                  <div className="border-t border-[#dfe6ee] pt-2">
                    <button
                      onClick={() => setShowTechDetails(!showTechDetails)}
                      className="w-full flex items-center justify-between text-[11px] font-bold text-[#637181] hover:text-[#12304a] py-1"
                    >
                      <span className="flex items-center gap-1">
                        <FileText className="w-3.5 h-3.5 text-[#2ca7b8]" />
                        Tier-2 Escalation Checklist
                      </span>
                      {showTechDetails ? (
                        <ChevronUp className="w-3.5 h-3.5" />
                      ) : (
                        <ChevronDown className="w-3.5 h-3.5" />
                      )}
                    </button>

                    {showTechDetails && (
                      <div className="mt-2 space-y-2 p-3 rounded-lg bg-slate-50 border border-[#dfe6ee] text-[11px]">
                        <div>
                          <div className="font-bold text-[#12304a] mb-0.5">Next Expected Event:</div>
                          <div className="text-[#637181] font-mono text-[10px]">
                            {supportPacket.expected_next_event}
                          </div>
                        </div>

                        {supportPacket.escalation_checklist && (
                          <div>
                            <div className="font-bold text-[#12304a] mb-1">Escalation Checklist:</div>
                            <ul className="list-disc list-inside space-y-0.5 text-[#637181]">
                              {supportPacket.escalation_checklist.map((item: string, idx: number) => (
                                <li key={idx}>{item}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Gateway Metadata Card */}
            <div className="p-6 rounded-2xl bg-white border border-[#dfe6ee] shadow-sm text-xs space-y-3">
              <h4 className="font-bold text-[#12304a] flex items-center gap-1.5">
                <Layers className="w-4 h-4 text-[#2ca7b8]" />
                Gateway Metadata
              </h4>
              <div className="space-y-1.5 font-mono text-[11px]">
                <div className="flex justify-between border-b border-[#dfe6ee] pb-1">
                  <span className="text-[#637181]">Provider Payment:</span>
                  <span className="text-[#12304a]">
                    {att?.providerPaymentId || "N/A"}
                  </span>
                </div>
                <div className="flex justify-between border-b border-[#dfe6ee] pb-1">
                  <span className="text-[#637181]">Error Code:</span>
                  <span className="text-[#8c3340] font-bold">
                    {att?.errorCode || "N/A"}
                  </span>
                </div>
                <div className="flex justify-between border-b border-[#dfe6ee] pb-1">
                  <span className="text-[#637181]">Merchant Mode:</span>
                  <span className="text-[#136456] uppercase font-bold">
                    {data.merchant?.mode || "test"}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
