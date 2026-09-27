'use client'

import { observer } from 'mobx-react-lite'
import React from 'react'
import { getStore } from '@/store/RootStore'

const store = getStore()

export const RoleGuard = observer(
  ({ roles, children }: { roles: ('admin' | 'coach')[]; children: React.ReactNode }) => {
    const role = store.authStore.user?.role
    if (!role || !roles.includes(role)) return null
    return <>{children}</>
  },
)
