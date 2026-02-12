/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Design tokens from Alpine UI
        teal: {
          500: '#0891B2',
          600: '#0e7490',
        },
        pink: {
          500: '#E11D73',
          600: '#be185d',
        },
        brand: {
          500: '#0ea5e9',
          600: '#0284c7',
        },
      },
    },
  },
  plugins: [],
}
