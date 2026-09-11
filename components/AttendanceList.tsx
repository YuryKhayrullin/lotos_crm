'use client'

import { observer } from 'mobx-react-lite'
import { useStore } from '@/store/StoreProvider'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'

export const AttendanceList = observer(() => {
  const store = useStore()
  const clients = store.branchClients

  return (
    <div className="grid gap-4">
      {clients.map((client) => {
        const remaining = client.remainingLessons
        const isDisabled = remaining <= 0

        return (
          <Card key={client.id} className="flex items-center justify-between p-4">
            <div>
              <p className="font-medium">{client.childName}</p>
              <Badge variant={isDisabled ? "secondary" : "default"}>
                Осталось: {remaining}
              </Badge>
            </div>
            <Button 
              onClick={() => store.clientStore.markAttendance(client.id, 'UNKNOWN_LESSON', 'attended')}
              disabled={isDisabled}
              variant={isDisabled ? "secondary" : "default"}
            >
              {isDisabled ? "Нет занятий" : "Был на тренировке"}
            </Button>
          </Card>
        )
      })}
    </div>
  )
})
