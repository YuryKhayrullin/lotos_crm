'use client'

import { RecoveryPanel } from '@/components/RecoveryPanel'

export default function ErrorPage({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main className="min-h-screen bg-slate-50 p-6 pt-16">
      <RecoveryPanel onRetry={retry} />
    </main>
  )
}
