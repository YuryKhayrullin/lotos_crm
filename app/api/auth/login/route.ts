import { NextResponse } from 'next/server'
import { callGas, GasError } from '@/lib/server/gas'
import { rejectCrossOrigin } from '@/lib/server/request'
import { createSession } from '@/lib/server/session'

export const runtime = 'nodejs'

function cleanText(value: unknown, max: number): string {
  const result = typeof value === 'string' ? value.trim() : ''
  if (!result || result.length > max) throw new Error('Некорректные данные входа')
  return result
}

export async function POST(request: Request) {
  const crossOriginResponse = rejectCrossOrigin(request)
  if (crossOriginResponse) return crossOriginResponse

  try {
    const body = (await request.json()) as Record<string, unknown>
    const username = cleanText(body.username, 100)
    const password = cleanText(body.password, 200)
    const response = (await callGas({ action: 'login', payload: { username, password } })) as Record<string, unknown>
    const gasUser = response.user as { role?: unknown; branchId?: unknown } | undefined
    const isCoach = ['coach', '2'].includes(String(gasUser?.role ?? '').toLowerCase())
    if (isCoach && (gasUser?.branchId === null || gasUser?.branchId === undefined || gasUser.branchId === '')) {
      return NextResponse.json(
        { status: 'error', message: 'Аккаунт ожидает назначения филиала администратором' },
        { status: 403 },
      )
    }
    const user = await createSession(response.user)
    return NextResponse.json({ status: 'success', user })
  } catch (error) {
    const status = error instanceof GasError ? error.status : 400
    return NextResponse.json(
      { status: 'error', message: error instanceof Error ? error.message : 'Ошибка входа' },
      { status },
    )
  }
}
