import { NextResponse } from 'next/server'
import { getSession } from '@/lib/server/session'

export const runtime = 'nodejs'

export async function GET() {
  const user = await getSession()
  return NextResponse.json({ authenticated: Boolean(user), user })
}
