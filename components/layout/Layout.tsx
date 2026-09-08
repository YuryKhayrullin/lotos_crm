'use client'

import { useStore } from '@/store'
import { observer } from 'mobx-react-lite'
import React from 'react'
import { Sidebar } from './Sidebar'
import { Header } from './Header'

interface LayoutProps {
  children: React.ReactNode
}

export const Layout: React.FC<LayoutProps> = observer(({ children }) => {
  const store = useStore()

  if (store.isLoading) {
    return null // LoaderFullScreen is rendered by StoreProvider
  }

  return (
    <div className="flex min-h-screen bg-muted/40">
      <Sidebar />
      <div className="flex flex-col flex-1">
        <Header />
        <main className="flex flex-1 flex-col gap-4 p-4 md:gap-8 md:p-6">
          {children}
        </main>
      </div>
    </div>
  )
})