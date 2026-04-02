/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        accent:        "#2563EB",
        "accent-dim":  "#1D4ED8",
        "accent-glow": "rgba(37,99,235,0.08)",
        surface:       "#FFFFFF",
        raised:        "#F1F5F9",
        overlay:       "#E2E8F0",
        base:          "#F8FAFC",
        "text-primary":   "#0F172A",
        "text-secondary": "#475569",
        "text-muted":     "#94A3B8",
        border:           "#E2E8F0",
      },
      fontFamily: {
        display: ["Inter", "-apple-system", "BlinkMacSystemFont", "PingFang SC", "sans-serif"],
        mono:    ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
        body:    ["Inter", "-apple-system", "BlinkMacSystemFont", "PingFang SC", "sans-serif"],
      },
      borderRadius: {
        card: "12px",
        btn:  "8px",
        nav:  "8px",
      },
      boxShadow: {
        card:   "0 1px 3px rgba(0,0,0,0.06)",
        "card-hover": "0 4px 12px rgba(0,0,0,0.1)",
        focus:  "0 0 0 3px rgba(37,99,235,0.12)",
      },
      animation: {
        shimmer:        "shimmer 2s linear infinite",
        "fade-up":      "fadeUp 0.35s ease both",
        "progress-glow":"progressGlow 2s ease-in-out infinite",
      },
      keyframes: {
        shimmer: {
          from: { backgroundPosition: "-200% center" },
          to:   { backgroundPosition: "200% center" },
        },
        fadeUp: {
          from: { opacity: "0", transform: "translateY(10px)" },
          to:   { opacity: "1", transform: "translateY(0)" },
        },
        progressGlow: {
          "0%,100%": { boxShadow: "0 0 6px rgba(37,99,235,0.5)" },
          "50%":     { boxShadow: "0 0 16px rgba(37,99,235,0.8), 0 0 32px rgba(37,99,235,0.2)" },
        },
      },
    },
  },
  plugins: [],
};
