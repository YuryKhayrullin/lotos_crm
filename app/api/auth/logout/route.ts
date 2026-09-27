import { NextResponse } from 'next/server'
import { rejectCrossOrigin } from '@/lib/server/request'
import { clearSession } from '@/lib/server/session'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  const crossOriginResponse = rejectCrossOrigin(request)
  if (crossOriginResponse) return crossOriginResponse

  await clearSession()
  return NextResponse.json({ status: 'success' })
}
