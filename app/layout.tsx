import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'
import { StoreProvider } from '@/store' // Import StoreProvider

const geist = Geist({ subsets: ['latin', 'cyrillic'], variable: '--font-geist' })
const geistMono = Geist_Mono({ subsets: ['latin', 'cyrillic'], variable: '--font-geist-mono' })

export const metadata: Metadata = {
  title: 'Лотос CRM',
  description: 'Управление филиалами, клиентами и расписанием Лотос',
  generator: 'v0.app',
}

export const viewport: Viewport = {
  colorScheme: 'light',
  themeColor: '#f5f9fb',
  userScalable: false,
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru" className="bg-background">
      <body className={`${geist.variable} ${geistMono.variable}`}>
        <StoreProvider> {/* Wrap children with StoreProvider */}
          {children}
        </StoreProvider>
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
