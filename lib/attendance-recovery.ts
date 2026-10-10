export type AttendanceStatus = 'attended' | 'absent'
export type AttendanceMap = Record<string, AttendanceStatus | null>
export type AttendanceAttempt = {
  lessonId: string
  date: string
  requestId: string
  attendanceList: { clientId: string; status: AttendanceStatus; expectedVersion?: number }[]
  expectedLessonVersion?: number
  reason?: string
}
export type AttendanceDraft = {
  attendance: AttendanceMap
  initialAttendance: AttendanceMap
  pendingAttempt: AttendanceAttempt | null
}

// One roster pass per edit, rather than searching the roster for each mark.
// Only current pupils can be sent; stale draft keys are deliberately ignored.
export function summarizeAttendance(
  roster: ReadonlyArray<{ id: string }>,
  attendance: AttendanceMap,
  initialAttendance: AttendanceMap,
) {
  const changedEntries: [string, AttendanceStatus][] = []
  let attendedCount = 0
  let absentCount = 0
  for (const client of roster) {
    const status = attendance[client.id]
    if (status === 'attended') attendedCount++
    else if (status === 'absent') absentCount++
    else continue
    if (status !== initialAttendance[client.id]) changedEntries.push([client.id, status])
  }
  return { changedEntries, attendedCount, absentCount, unmarkedCount: roster.length - attendedCount - absentCount }
}

// Memory only: no pupil names, tokens or attendance data in localStorage.
// Entries are scoped to a session and cleared on authentication transitions.
const drafts = new Map<string, AttendanceDraft>()

export function getAttendanceDraft(key: string): AttendanceDraft | undefined {
  return drafts.get(key)
}

export function rememberAttendanceDraft(key: string, draft: AttendanceDraft): void {
  drafts.set(key, draft)
}

export function forgetAttendanceDraft(key: string): void {
  drafts.delete(key)
}

export function clearAttendanceDrafts(): void {
  drafts.clear()
}

export function isDefiniteAttendanceRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as { status?: unknown; attendanceOutcomeUnknown?: unknown }
  // A later chunk can fail after the earlier chunks were already committed.
  if (value.attendanceOutcomeUnknown) return false
  return [400, 401, 403, 404, 409, 422].includes(Number(value.status))
}
