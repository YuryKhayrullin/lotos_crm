'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useStore } from '@/store/StoreProvider'
import { observer } from 'mobx-react-lite'

export const AdminAddLessons = observer(({ clientId }: { clientId: string }) => {
  const store = useStore()
  const [count, setCount] = useState<number>(8)

  const handleAdd = async () => {
    await store.clientStore.addLessons(clientId, count)
  }

  return (
    <div className="flex items-center gap-2 mt-2">
      <Input 
        type="number" 
        value={count} 
        onChange={(e) => setCount(Number(e.target.value))} 
        className="w-20"
      />
      <Button onClick={handleAdd} size="sm" disabled={store.clientStore.isLoading}>
        Начислить
      </Button>
    </div>
  )
})
