/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Readex Pro', 'sans-serif'],
      },
      colors: {
        neu: {
          bg: '#ebf1f6',
          card: '#f4f7fb',
          dark: '#a3b1c6',
          light: '#ffffff',
          accent: '#3b82f6',
        }
      }
    },
  },
  plugins: [],
}
