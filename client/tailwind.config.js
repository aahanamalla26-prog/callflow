/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['"Hanken Grotesk"', 'system-ui', 'sans-serif'] },
      colors: {
        floor: '#E9ECEE',   // concrete
        ink: '#1A2430',
        steel: '#5B6773',
        line: '#D3D8DC',
        bay: '#0E5A78',     // primary
        ok: '#2C7A4B',
        warn: '#B7791F',
        bad: '#B83A2E',
      },
    },
  },
  plugins: [],
};
