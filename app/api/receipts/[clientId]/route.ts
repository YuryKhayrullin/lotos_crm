import { NextResponse } from 'next/server'
import { callGas, GasError } from '@/lib/server/gas'
import { getSession } from '@/lib/server/session'

export const runtime = 'nodejs'

export async function GET(_request: Request, context: { params: Promise<{ clientId: string }> }) {
  const user = await getSession()
  if (!user) return NextResponse.json({ status: 'error', message: 'Требуется авторизация' }, { status: 401 })
  if (user.role !== 'admin')
    return NextResponse.json({ status: 'error', message: 'Недостаточно прав' }, { status: 403 })

  const { clientId } = await context.params
  if (!clientId || clientId.length > 100) {
    return NextResponse.json({ status: 'error', message: 'Некорректный clientId' }, { status: 400 })
  }

  try {
    const result = (await callGas({
      action: 'getReceipt',
      payload: { clientId },
      auth: { id: user.id, username: user.username, role: user.role, branchId: user.branchId },
    })) as { base64?: string; mimeType?: string; fileName?: string }
    if (!result.base64) return NextResponse.json({ status: 'error', message: 'Квитанция не найдена' }, { status: 404 })
    const bytes = Buffer.from(result.base64, 'base64')
    const filename = encodeURIComponent(result.fileName || 'receipt')
    return new Response(bytes, {
      headers: {
        'Content-Type': result.mimeType || 'application/octet-stream',
        'Content-Length': String(bytes.byteLength),
        'Content-Disposition': `inline; filename*=UTF-8''${filename}`,
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (error) {
    const status = error instanceof GasError ? error.status : 502
    return NextResponse.json(
      { status: 'error', message: error instanceof Error ? error.message : 'Ошибка квитанции' },
      { status },
    )
  }
}
