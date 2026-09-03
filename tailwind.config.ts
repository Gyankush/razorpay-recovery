import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        payrescue: {
          navy: "#12304a",
          blue: "#1d6b9f",
          cyan: "#2ca7b8",
          mint: "#dff5ef",
          amber: "#fff1c7",
          rose: "#ffe5e5",
          soft: "#f4f7fa",
          line: "#dfe6ee",
          ink: "#17212b",
          muted: "#637181",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
      },
      boxShadow: {
        card: "0 8px 30px rgba(18, 48, 74, 0.06)",
        pop: "0 12px 32px rgba(18, 48, 74, 0.12)",
      },
      keyframes: {
        fadeIn: {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        slideUp: {
          from: { opacity: "0", transform: "translateY(10px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        fadeIn: "fadeIn 0.45s ease both",
        slideUp: "slideUp 0.5s cubic-bezier(0.21, 1.02, 0.73, 1) both",
      },
    },
  },
  plugins: [],
};

export default config;
