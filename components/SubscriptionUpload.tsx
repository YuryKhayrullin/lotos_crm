'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useStore } from '@/store/StoreProvider'
import { observer } from 'mobx-react-lite'

export const SubscriptionUpload = observer(({ clientId }: { clientId: string }) => {
  const store = useStore()
  const [file, setFile] = useState<File | null>(null)
  const [lessons, setLessons] = useState<number>(8)

  const handleUpload = async () => {
    if (!file) return
    await store.clientStore.addSubscription(clientId, file, lessons)
  }

  return (
    <div className="flex flex-col gap-4 p-4 border rounded-xl">
      <Input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} />
      <Input type="number" value={lessons} onChange={(e) => setLessons(Number(e.target.value))} placeholder="Кол-во занятий" />
      <Button onClick={handleUpload} disabled={store.clientStore.isLoading}>
        {store.clientStore.isLoading ? 'Загрузка...' : 'Добавить подписку'}
      </Button>
    </div>
  )
})
