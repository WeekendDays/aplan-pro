module.exports = {
  content: [
    './src/**/*.{js,jsx,ts,tsx}',
    './index.html'
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        primary: '#0d99ff',
        figma: {
          bg: '#f5f5f5',
          surface: '#ffffff',
          border: '#e5e5e5',
          text: '#1e1e1e',
          muted: '#8c8c8c',
          subtle: '#b3b3b3',
        }
      },
      fontSize: {
        '2xs': '11px',
      }
    }
  },
  plugins: []
};
