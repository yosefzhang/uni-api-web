import { NextRequest, NextResponse } from 'next/server';
import { requireKey } from '@/lib/status-config';
import { queryRows } from '@/lib/status-db';

export async function GET(request: NextRequest) {
  try {
    const apiKey = request.nextUrl.searchParams.get('apiKey');
    const { entry } = requireKey(apiKey);
    const api = entry.api;
    const rows = queryRows({
      sql: `SELECT COUNT(*) as requests,
        COALESCE(SUM(total_tokens), 0) as totalTokens,
        COALESCE(SUM(prompt_tokens), 0) as promptTokens,
        COALESCE(SUM(completion_tokens), 0) as completionTokens,
        COALESCE(AVG(process_time), 0) as avgProcessTime,
        COALESCE(AVG(first_response_time), 0) as avgFirstResponseTime
        FROM request_stats WHERE api_key = ?`,
      params: [api],
    });
    const stats = rows[0] || {
      requests: 0, totalTokens: 0, promptTokens: 0,
      completionTokens: 0, avgProcessTime: 0, avgFirstResponseTime: 0,
    };
    return NextResponse.json(stats);
  } catch (e: any) {
    return NextResponse.json(e.body || { error: e.message }, { status: e.status || 500 });
  }
}
