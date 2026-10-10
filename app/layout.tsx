import type { Metadata, Viewport } from 'next'
import { headers } from 'next/headers'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'
import { StoreProvider } from '@/store' // Import StoreProvider
const geistSans = Geist({ subsets: ['latin', 'cyrillic'], display: 'swap', variable: '--font-geist-sans' })
const geistMono = Geist_Mono({ subsets: ['latin', 'cyrillic'], display: 'swap', variable: '--font-geist-mono' })

export const metadata: Metadata = {
  title: 'Лотос CRM',
  description: 'Управление филиалами, клиентами и расписанием Лотос',
  generator: 'v0.app',
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon-light-32x32.png', type: 'image/png', sizes: '32x32' },
    ],
    apple: '/apple-icon.png',
  },
}

export const viewport: Viewport = {
  colorScheme: 'light',
  themeColor: '#f5f9fb',
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Reading request headers opts the entire shell into dynamic rendering.
  // A static/cached shell cannot safely reuse a request-specific CSP nonce.
  await headers()
  return (
    <html lang="ru" className="bg-background">
      <body className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased`}>
        <StoreProvider>{children}</StoreProvider>
      </body>
    </html>
  )
}
