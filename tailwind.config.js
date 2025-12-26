/** @type {import('tailwindcss').Config} */
module.exports = {
    content: ['./index.html', './public/**/*.html'],
    theme: {
        extend: {
            colors: {
                'united-red': '#DA291C',
                'neon-green': '#00ff9d',
                'dark-bg': '#050505',
                'dark-card': '#0a0a0a',
                'dark-border': '#1a1a1a'
            },
            fontFamily: {
                'display': ['Inter', 'sans-serif'],
                'mono': ['JetBrains Mono', 'monospace']
            }
        }
    },
    plugins: []
}
