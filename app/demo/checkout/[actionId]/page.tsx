"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ShieldCheck,
  CheckCircle2,
  RefreshCw,
  AlertTriangle,
  CreditCard,
  FlaskConical,
} from "lucide-react";

interface CheckoutInfo {
  amount: number;
  currency: string;
  order_ref: string;
  status: string;
  expiry: string | null;
  action_status: string;
}

function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export default function DemoCheckoutPage() {
  const params = useParams();
  const actionId = params?.actionId as string;
  const [info, setInfo] = useState<CheckoutInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  const [paid, setPaid] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!actionId) return;
    fetch(`/api/demo/checkout/${actionId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => setInfo(j.checkout))
      .catch(() => setError("This demo checkout link is invalid or expired."))
      .finally(() => setLoading(false));
  }, [actionId]);

  const pay = async () => {
    try {
      setPaying(true);
      setError(null);
      const res = await fetch(`/api/demo/checkout/${actionId}`, { method: "POST" });
      const data = await res.json();
      if (res.ok && data.success) {
        setPaid(true);
      } else {
        setError(data.error || "Demo payment failed");
      }
    } catch {
      setError("Demo payment failed");
    } finally {
      setPaying(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f4f7fa] flex items-center justify-center p-6">
      <div className="max-w-md w-full">
        <div className="mb-4 inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-[#fff1c7] text-[#725311] border border-[#f1d885]">
          <FlaskConical className="w-3.5 h-3.5" />
          Demo sandbox — no real money moves here
        </div>

        <div className="p-8 rounded-3xl bg-white border border-[#dfe6ee] shadow-sm text-center animate-slideUp">
          {loading ? (
            <div className="py-8 text-sm text-[#637181]">
              <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-3 text-[#2ca7b8]" />
              Loading secure checkout…
            </div>
          ) : error && !paid ? (
            <div className="py-6">
              <AlertTriangle className="w-8 h-8 mx-auto mb-3 text-[#8c3340]" />
              <h1 className="text-lg font-extrabold text-[#12304a]">Checkout unavailable</h1>
              <p className="text-sm text-[#637181] mt-1">{error}</p>
              <Link href="/" className="inline-block mt-5 text-xs font-bold text-[#1d6b9f] hover:underline">
                ← Back to PayRescue control room
              </Link>
            </div>
          ) : paid || info?.status === "paid" ? (
            <div className="py-4">
              <CheckCircle2 className="w-12 h-12 mx-auto mb-3 text-[#136456]" />
              <h1 className="text-xl font-extrabold text-[#12304a]">Payment successful</h1>
              <p className="text-sm text-[#637181] mt-2">
                {info ? formatMoney(info.amount, info.currency) : ""} received for order{" "}
                <span className="font-mono font-bold text-[#12304a]">{info?.order_ref}</span>.
                The merchant case is resolved and the audit trail updated.
              </p>
              <div className="mt-4 p-3 rounded-xl bg-[#dff5ef] border border-[#b6e7dc] text-xs text-[#136456] font-medium">
                Demo complete — this is exactly what a real customer payment triggers: capture →
                link paid → case resolved → merchant notified.
              </div>
              <Link href="/" className="inline-block mt-5 text-xs font-bold text-[#1d6b9f] hover:underline">
                ← Back to PayRescue control room
              </Link>
            </div>
          ) : (
            info && (
              <div>
                <div className="w-12 h-12 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-[#2ca7b8] to-[#12304a] flex items-center justify-center text-white">
                  <CreditCard className="w-6 h-6" />
                </div>
                <p className="text-xs font-bold uppercase tracking-wider text-[#637181]">PayRescue recovery checkout</p>
                <div className="text-4xl font-black text-[#12304a] num mt-2">
                  {formatMoney(info.amount, info.currency)}
                </div>
                <p className="text-xs text-[#637181] mt-1 font-mono">Order {info.order_ref}</p>
                <div className="mt-3 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#e9f4fc] border border-[#b9dbf4] text-[11px] font-bold text-[#1d5d86]">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  Simulated 3-D Secure — always succeeds
                </div>
                <button
                  onClick={pay}
                  disabled={paying}
                  className="mt-6 w-full py-3 rounded-xl bg-[#12304a] hover:bg-[#164b66] active:scale-[0.99] text-white font-bold text-sm shadow transition disabled:opacity-50"
                >
                  {paying ? "Processing…" : `Pay ${formatMoney(info.amount, info.currency)}`}
                </button>
                <p className="mt-3 text-[11px] text-[#637181]">
                  Demo card •••• 4242 · expires {info.expiry ? new Date(info.expiry).toLocaleString() : "in 60 min"}
                </p>
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}
