import { NextRequest, NextResponse } from 'next/server';
import { requireKey } from '@/lib/status-config';
import { queryRows } from '@/lib/status-db';

const RANKING_SQL = `SELECT r.provider as provider,
  COUNT(*) as requests,
  COALESCE(SUM(CASE WHEN c.success = 1 THEN 1 ELSE 0 END), 0) as successes,
  COALESCE(SUM(CASE WHEN c.success = 0 THEN 1 ELSE 0 END), 0) as failures,
  COALESCE(AVG(CAST(COALESCE(c.success, 0) AS REAL)), 0) as successRate,
  COALESCE(SUM(r.total_tokens), 0) as totalTokens,
  COALESCE(SUM(r.prompt_tokens), 0) as promptTokens,
  COALESCE(SUM(r.completion_tokens), 0) as completionTokens,
  COALESCE(AVG(r.process_time), 0) as avgProcessTime,
  COALESCE(AVG(r.first_response_time), 0) as avgFirstResponseTime
  FROM request_stats r LEFT JOIN channel_stats c ON r.request_id = c.request_id
  WHERE r.api_key = ? AND r.endpoint = '/v1/chat/completions'
  GROUP BY r.provider ORDER BY requests DESC`;

export async function GET(request: NextRequest) {
  try {
    const apiKey = request.nextUrl.searchParams.get('apiKey');
    const { entry } = requireKey(apiKey);
    const rows = queryRows({ sql: RANKING_SQL, params: [entry.api] });
    return NextResponse.json(rows);
  } catch (e: any) {
    return NextResponse.json(e.body || { error: e.message }, { status: e.status || 500 });
  }
}
