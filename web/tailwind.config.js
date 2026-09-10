/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        sidebar: {
          bg: '#201e1d',
          active: 'rgba(243, 242, 242, 0.06)',
          fg: '#f3f2f2',
          'fg-85': 'rgba(243, 242, 242, 0.85)',
          'fg-75': 'rgba(243, 242, 242, 0.75)',
          'fg-55': 'rgba(243, 242, 242, 0.55)',
          'fg-50': 'rgba(243, 242, 242, 0.5)',
          border: 'rgba(243, 242, 242, 0.1)',
        },
      },
      borderRadius: {
        sm: '4px',
        md: '8px',
        lg: '12px',
      },
    },
  },
  plugins: [],
};
