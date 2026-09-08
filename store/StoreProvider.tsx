"use client"

import { createContext, useContext, useEffect, useState, ReactNode } from "react"
import { getStore, type IRootStore } from "./RootStore"
import { LoaderFullScreen } from "@/components/ui/loader-full-screen"
import { ThemeProvider } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import { theme } from '@/lib/theme'

const StoreContext = createContext<IRootStore | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const store = getStore()
  const [isInitializing, setIsInitializing] = useState(true)

  useEffect(() => {
    const initialize = async () => {
      await store.initialize()
      setIsInitializing(false)
    }
    initialize()
  }, [store])

  if (isInitializing) {
    return <LoaderFullScreen />
  }

  return (
    <StoreContext.Provider value={store}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </StoreContext.Provider>
  )
}

export function useStore() {
  const context = useContext(StoreContext)
  if (!context) {
    throw new Error("useStore must be used within StoreProvider")
  }
  return context
}