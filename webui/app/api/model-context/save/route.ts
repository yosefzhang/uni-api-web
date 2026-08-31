import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, writeModelContext } from '@/lib/status-config';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const apiKey = body.apiKey;
    const data = body.data;
    if (!apiKey || !data || typeof data !== 'object' || Array.isArray(data)) {
      return NextResponse.json(
        { error: 'API Key and a JSON object data are required' },
        { status: 400 }
      );
    }
    requireAdmin(apiKey);
    writeModelContext(data);
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json(e.body || { error: e.message }, { status: e.status || 500 });
  }
}