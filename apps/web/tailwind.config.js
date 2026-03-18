/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        accent: "#f59e0b",
        "accent-dim": "#d97706",
        surface: "#111113",
        raised: "#18181c",
        overlay: "#1f1f25",
        base: "#0a0a0b",
      },
      fontFamily: {
        display: ["Syne", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
        body: ["Inter", "sans-serif"],
      },
      animation: {
        shimmer: "shimmer 2s linear infinite",
        "fade-up": "fadeUp 0.4s ease both",
        "progress-glow": "progressGlow 2s ease-in-out infinite",
      },
      keyframes: {
        shimmer: {
          from: { backgroundPosition: "-200% center" },
          to: { backgroundPosition: "200% center" },
        },
        fadeUp: {
          from: { opacity: "0", transform: "translateY(12px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        progressGlow: {
          "0%,100%": { boxShadow: "0 0 8px #f59e0b" },
          "50%": { boxShadow: "0 0 20px #f59e0b, 0 0 40px rgba(245,158,11,0.15)" },
        },
      },
    },
  },
  plugins: [],
};
