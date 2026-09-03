import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "PayRescue — International Payment Recovery Copilot",
    template: "%s · PayRescue",
  },
  description:
    "AI-powered payment truth, failure diagnosis, safe recovery, and audit reconciliation for international Razorpay payments.",
  applicationName: "PayRescue",
  metadataBase: new URL("http://localhost:3000"),
  openGraph: {
    title: "PayRescue — International Payment Recovery Copilot",
    description:
      "Diagnose failed international payments, recover safely with human approval, and prove it with an immutable audit trail.",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#12304a",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#f4f7fa] text-[#17212b] antialiased flex flex-col">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:px-3 focus:py-2 focus:bg-white focus:rounded-lg focus:text-xs focus:font-bold focus:text-[#12304a] focus:shadow"
        >
          Skip to content
        </a>
        <div id="main-content" className="flex-1 flex flex-col">
          {children}
        </div>

        {/* Product Footer */}
        <footer className="border-t border-[#dfe6ee] bg-white/80 backdrop-blur mt-auto">
          <div className="max-w-7xl mx-auto px-6 py-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div
                aria-hidden
                className="w-7 h-7 rounded-lg bg-gradient-to-br from-[#2ca7b8] to-[#12304a] flex items-center justify-center text-white font-extrabold text-xs shadow-sm"
              >
                P
              </div>
              <div>
                <span className="text-xs font-bold text-[#12304a]">PayRescue</span>
                <span className="mx-1.5 text-[#dfe6ee]">·</span>
                <span className="text-xs font-semibold text-[#2ca7b8]">
                  Truth · Recovery · Proof
                </span>
              </div>
            </div>
            <div className="flex items-center gap-4 text-[11px] text-[#637181]">
              <span>
                Built by{" "}
                <span className="font-bold text-[#12304a]">System Admin</span>
              </span>
              <span className="text-[#dfe6ee]">|</span>
              <span>Razorpay AI Buildathon 2026</span>
              <span className="text-[#dfe6ee]">|</span>
              <a href="/audit" className="hover:text-[#12304a] font-semibold">
                Audit Trail
              </a>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
