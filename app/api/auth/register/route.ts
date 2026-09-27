import { NextResponse } from 'next/server'
import { callGas, GasError } from '@/lib/server/gas'
import { rejectCrossOrigin } from '@/lib/server/request'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  const crossOriginResponse = rejectCrossOrigin(request)
  if (crossOriginResponse) return crossOriginResponse

  try {
    const body = (await request.json()) as Record<string, unknown>
    const username = typeof body.username === 'string' ? body.username.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (!username || username.length > 100 || !password || password.length < 8 || password.length > 200) {
      return NextResponse.json({ status: 'error', message: 'Укажите логин и пароль от 8 до 200 символов' }, { status: 400 })
    }
    const response = await callGas({ action: 'register', payload: { username, password } })
    return NextResponse.json(response)
  } catch (error) {
    const status = error instanceof GasError ? error.status : 400
    return NextResponse.json(
      { status: 'error', message: error instanceof Error ? error.message : 'Ошибка регистрации' },
      { status },
    )
  }
}
