'use client'

import { createTheme } from '@mui/material/styles'

export const theme = createTheme({
  palette: {
    primary: {
      main: '#0ea5e9', // Sky 500 (близко к текущему лого)
    },
    secondary: {
      main: '#be185d', // Pink 700
    },
    background: {
      default: '#f8fafc', // Slate 50
    },
  },
  typography: {
    fontFamily: 'var(--font-geist-sans), Inter, sans-serif',
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 12,
          textTransform: 'none',
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          borderRadius: 16,
          boxShadow: '0 10px 30px -20px rgba(190,80,125,.25)',
        },
      },
    },
  },
})
