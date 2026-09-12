import { NextResponse } from 'next/server';
import { SignJWT, jwtVerify } from 'jose';
import crypto from 'crypto';

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET || 'fallback-secret-key-change-me');

function sha256(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}

async function verifyToken(request: Request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.log('No auth header or invalid format');
    return null;
  }
  
  const token = authHeader.split(' ')[1];
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return payload;
  } catch (e: any) {
    console.error('JWT verification error details:', e.message, e.code);
    return null;
  }
}

export async function GET(request: Request) {
  try {
    const user = await verifyToken(request);
    if (!user) return NextResponse.json({ status: 'error', message: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const sheet = searchParams.get('sheet');
    
    const backendUrl = process.env.GAS_BACKEND_URL;
    if (!backendUrl) return NextResponse.json({ status: 'error', message: 'Backend URL not configured' }, { status: 500 });
    
    const targetUrl = new URL(backendUrl);
    if (sheet) targetUrl.searchParams.set('sheet', sheet);
    
    const response = await fetch(targetUrl.toString(), { method: 'GET' });
    if (!response.ok) return NextResponse.json({ status: 'error', message: 'Backend request failed' }, { status: response.status });
    
    const data = await response.json();
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ status: 'error', message: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const backendUrl = process.env.GAS_BACKEND_URL;
    if (!backendUrl) return NextResponse.json({ status: 'error', message: 'Backend URL not configured' }, { status: 500 });
    
    const body = await request.json();
    const { action, username, password, ...rest } = body;

    // Handle Auth Actions
    if (action === 'register') {
      const hashedPassword = sha256(password);
      const response = await fetch(backendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, username, password: hashedPassword, ...rest }),
      });
      return NextResponse.json(await response.json());
    }

    if (action === 'login') {
      // Отправляем запрос на GAS с правильным action: 'login' и хэшированным паролем
      const response = await fetch(backendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'login', username, password: sha256(password) }),
      });

      const data = await response.json();

      // Если GAS вернул ошибку или статус не success
      if (!response.ok || data.status !== 'success') {
        return NextResponse.json({ status: 'error', message: 'Invalid credentials' }, { status: 401 });
      }

      // GAS успешно подтвердил данные пользователя (data.user)
      const user = data.user;

      // 3. Создаем JWT токен
      const token = await new SignJWT({ id: user.id, username, role: user.role })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('24h')
        .sign(JWT_SECRET);

      return NextResponse.json({ user, token });
    }

    // Proxy other requests
    const user = await verifyToken(request);
    if (!user) return NextResponse.json({ status: 'error', message: 'Unauthorized' }, { status: 401 });

    const response = await fetch(backendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
    });
    
    return NextResponse.json(await response.json());
  } catch (error: any) {
    return NextResponse.json({ status: 'error', message: error.message }, { status: 500 });
  }
}
