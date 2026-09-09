import { NextRequest, NextResponse } from 'next/server';
import { requireKey } from '@/lib/status-config';
import { queryRows } from '@/lib/status-db';

export async function GET(request: NextRequest) {
  try {
    const apiKey = request.nextUrl.searchParams.get('apiKey');
    const { entry } = requireKey(apiKey);
    const api = entry.api;
    const models = queryRows({
      sql: `SELECT DISTINCT model FROM request_stats WHERE api_key = ? ORDER BY model`,
      params: [api],
    }).map((r) => r.model).filter((v) => v != null);
    const providers = queryRows({
      sql: `SELECT DISTINCT provider FROM request_stats WHERE api_key = ? ORDER BY provider`,
      params: [api],
    }).map((r) => r.provider).filter((v) => v != null);
    return NextResponse.json({ models, providers });
  } catch (e: any) {
    return NextResponse.json(e.body || { error: e.message }, { status: e.status || 500 });
  }
}
