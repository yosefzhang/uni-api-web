import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, readModelContext } from '@/lib/status-config';

export async function GET(request: NextRequest) {
  try {
    const apiKey = request.nextUrl.searchParams.get('apiKey');
    requireAdmin(apiKey);
    return NextResponse.json({ data: readModelContext() });
  } catch (e: any) {
    return NextResponse.json(e.body || { error: e.message }, { status: e.status || 500 });
  }
}