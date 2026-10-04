'use client'

import { createContext, useContext, ReactNode, useEffect } from 'react'
import { getStore, type IRootStore } from './RootStore'

const StoreContext = createContext<IRootStore | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const store = getStore()

  useEffect(() => {
    if (!store.authStore.isInitialized) {
      store.authStore.init()
    }
  }, [store])

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}

export function useStore() {
  const context = useContext(StoreContext)
  if (!context) {
    throw new Error('useStore must be used within StoreProvider')
  }
  return context
}
