import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        brand: {
          bg: '#0A0A0A',
          surface: '#141414',
          border: '#262626',
          muted: '#A3A3A3',
          text: '#F5F5F5',
          violet: '#8b5cf6',
          purple: '#9333ea',
          lime: '#84cc16',
          error: '#ef4444',
        },
      },
    },
  },
  plugins: [],
};

export default config;
