import { flow, types, Instance } from 'mobx-state-tree'
import { apiClient } from '@/lib/api-client'

// Client pages own their own pagination and filters. This store remains only as
// a shared write helper for the attendance modal, which has its own roster API.
export const ClientStore = types.model('ClientStore', {}).actions(() => ({
  markBulkAttendance: flow(function* (
    attendanceList: {
      clientId: string
      status: 'attended' | 'absent'
      expectedVersion?: number
    }[],
    lessonId: string,
    date: string,
    requestId: string,
    metadata?: { expectedLessonVersion?: number; reason?: string },
  ) {
    const result = yield apiClient.recordBulkAttendance(attendanceList, lessonId, date, requestId, metadata)
    const failures = Array.isArray(result.results)
      ? result.results.filter((item: { success: boolean }) => !item.success)
      : []
    if (!result.success || failures.length > 0) {
      const details = failures.map((item: { message?: string }) => item.message || 'неизвестная ошибка').join('; ')
      throw new Error(details ? `Не все отметки сохранены: ${details}` : 'Не все отметки сохранены')
    }
    return result
  }),
}))

export type IClientStore = Instance<typeof ClientStore>
