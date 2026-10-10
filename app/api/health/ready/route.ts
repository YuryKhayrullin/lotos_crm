import { getPostgresClient } from '@/lib/server/postgres/client'
import { postgresReadiness } from '@/lib/server/postgres/health'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function GET() {
  let ready = false
  try {
    if (process.env.CRM_BACKEND === 'postgres') ready = await postgresReadiness(getPostgresClient(), process.env)
  } catch {}
  return Response.json(
    { status: ready ? 'ready' : 'unavailable' },
    {
      status: ready ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    },
  )
}
