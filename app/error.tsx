"use client";

import Link from "next/link";
import { useEffect } from "react";
import { AlertTriangle, ArrowLeft, RefreshCw } from "lucide-react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("PayRescue route error:", error);
  }, [error]);

  return (
    <div className="min-h-screen bg-[#f4f7fa] flex items-center justify-center p-6">
      <div className="max-w-md w-full p-8 rounded-3xl bg-white border border-[#dfe6ee] shadow-sm text-center animate-slideUp">
        <div className="w-12 h-12 mx-auto mb-4 rounded-2xl bg-[#ffe5e5] text-[#8c3340] flex items-center justify-center">
          <AlertTriangle className="w-6 h-6" />
        </div>
        <h1 className="text-xl font-extrabold text-[#12304a] tracking-tight">
          Something went wrong
        </h1>
        <p className="text-sm text-[#637181] mt-2">
          The control room hit an unexpected error. Your data is safe — try
          again or return to the queue.
        </p>
        {error?.digest && (
          <p className="mt-3 font-mono text-[11px] text-[#637181]">
            Ref: {error.digest}
          </p>
        )}
        <div className="mt-6 flex items-center justify-center gap-2">
          <button
            onClick={reset}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#12304a] hover:bg-[#164b66] text-white text-xs font-bold transition"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Try again
          </button>
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-white border border-[#dfe6ee] hover:bg-slate-50 text-[#12304a] text-xs font-bold transition"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Back to queue
          </Link>
        </div>
      </div>
    </div>
  );
}
