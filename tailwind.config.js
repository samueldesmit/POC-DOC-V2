/** @type {import('tailwindcss').Config} */
module.exports = {
    content: [
        './**/*.liquid',
        './src/**/*.{js,ts,css}',
        './sections/**/*.liquid',
        './snippets/**/*.liquid',
        './layout/**/*.liquid',
        './templates/**/*.liquid',
    ],
    theme: {
        // Palette (surface, brand), fonts (heading, body), screens and radii come from design-tokens.json
        // through src/assets/tailwind/tokens.css (npm run tokens).
        extend: {
            colors: {
                background: 'var(--color-background)',
                primary: 'var(--color-primary)',
                secondary: 'var(--color-secondary)',
                'primary-background': 'var(--color-primary-background)',
                'primary-foreground': 'var(--color-primary-foreground)',
                'secondary-background': 'var(--color-secondary-background)',
                'secondary-foreground': 'var(--color-secondary-foreground)',
                arrows: 'var(--color-arrows)',
                'svg-background': 'var(--color-svg-background)',
                shadow: 'var(--color-shadow)',
                'disabled-background': 'var(--color-disabled-background)',
                'disabled-foreground': 'var(--color-disabled-foreground)',
                info: 'var(--color-info)',
                success: 'var(--color-success)',
                warning: 'var(--color-warning)',
                error: 'var(--color-error)',
            },
            fontFamily: {
                poppins: ['Poppins', 'sans-serif'],
            },
            fontWeight: {
                light: 300,
                regular: 400,
                bold: 700,
            },
            lineHeight: {
                3: '1.3',
                tight: '1.3',
            },
            letterSpacing: {
                1: '0.01em',
                2: '0.02em',
            },
            aspectRatio: {
                '4/3': '4 / 3',
            },
            spacing: {
                section: '3rem', // 51.2px
                'header-height': 'var(--header-height)', // Dynamisch
            },
            width: {
                full: '100%',
            },
            borderWidth: {
                1: '0.063',
            },
            zIndex: {
                90: '90',
            },
            wordBreak: {
                auto: 'auto',
            },
            keyframes: {
                appear: {
                    '0%': { opacity: 0 },
                    '100%': { opacity: 1 },
                },
                atcTickPop: {
                    '0%': {
                        opacity: 0,
                        transform: 'scale(0.9)',
                    },
                    '100%': {
                        opacity: 1,
                        transform: 'scale(1)',
                    },
                },
                atcTickDraw: {
                    to: {
                        'stroke-dashoffset': '0',
                    },
                },
            },
            animation: {
                appear: 'appear 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                'atc-tick-pop': 'atcTickPop 200ms ease-out forwards',
                'atc-tick-draw': 'atcTickDraw 350ms ease-out forwards',
            },
        },
    },
    plugins: [
        /* Base */
        require('./src/assets/tailwind/base/typography'),

        /* Layout */
        require('./src/assets/tailwind/base/layout'),

        /* Components */
        /* Utilities */
        require('./src/assets/tailwind/utilities/scrollbar-none'),
    ],
};
