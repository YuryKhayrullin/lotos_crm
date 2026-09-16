'use client'

import { observer } from 'mobx-react-lite'
import { getStore } from '@/store/RootStore'
import React from 'react'

const store = getStore()

interface RoleGuardProps {
  roles: ('admin' | 'coach')[]
  children: React.ReactNode
}

export const RoleGuard = observer(({ roles, children }: RoleGuardProps) => {
  const userRole = store.authStore.user?.role
  
  // Если пользователь - админ, разрешаем всегда
  if (userRole === 'admin') {
    return <>{children}</>
  }

  // Если роль не админ, проверяем по списку разрешенных
  if (!userRole || !roles.includes(userRole as 'admin' | 'coach')) {
    return null
  }
  
  return <>{children}</>
})
