import { NextRequest, NextResponse } from 'next/server';

const GAS_WEBAPP_URL = process.env.GAS_WEBAPP_URL;
const GAS_API_SECRET = process.env.GAS_API_SECRET;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action, payload } = body;

    console.log('Proxying POST request to GAS:', { action });

    if (!GAS_WEBAPP_URL || GAS_WEBAPP_URL === 'insert_gas_url_here' || !GAS_API_SECRET || GAS_API_SECRET === 'insert_secret_key_here') {
      console.error('API configuration missing or placeholders found');
      return NextResponse.json({ status: 'error', message: 'API configuration missing' }, { status: 500 });
    }

    const response = await fetch(GAS_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        apiKey: GAS_API_SECRET, 
        action,
        payload 
      }),
    });

    // Log the raw response text to debug
    const responseText = await response.text();
    console.log('GAS raw response (first 200 chars):', responseText.substring(0, 200));

    try {
      const data = JSON.parse(responseText);
      return NextResponse.json(data);
    } catch (parseError) {
      console.error('Failed to parse GAS response as JSON. Raw response:', responseText);
      return NextResponse.json({ status: 'error', message: 'Invalid JSON from GAS' }, { status: 502 });
    }
  } catch (error) {
    console.error('BFF Proxy error:', error);
    return NextResponse.json({ status: 'error', message: 'Proxy internal error' }, { status: 500 });
  }
}
