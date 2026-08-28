import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/status-config';

export async function GET(request: NextRequest) {
  try {
    const apiKey = request.nextUrl.searchParams.get('apiKey');
    const { content } = requireAdmin(apiKey);
    return NextResponse.json({ config: content });
  } catch (e: any) {
    return NextResponse.json(e.body || { error: e.message }, { status: e.status || 500 });
  }
}
