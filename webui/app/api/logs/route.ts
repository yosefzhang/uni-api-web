import { NextRequest, NextResponse } from 'next/server';
import { requireKey } from '@/lib/status-config';
import { queryRows } from '@/lib/status-db';

export async function GET(request: NextRequest) {
  try {
    const apiKey = request.nextUrl.searchParams.get('apiKey');
    const { entry } = requireKey(apiKey);
    const api = entry.api;
    const sp = request.nextUrl.searchParams;
    const page = Math.max(1, parseInt(sp.get('page') || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(sp.get('limit') || '30', 10)));
    const model = sp.get('model');
    const provider = sp.get('provider');
    const status = sp.get('status');

    const whereClauses = ['r.api_key = ?', 'r.endpoint = ?'];
    const params: any[] = [api, '/v1/chat/completions'];
    if (model) { whereClauses.push(`r.model = ?`); params.push(model); }
    if (provider) { whereClauses.push(`r.provider = ?`); params.push(provider); }
    if (status) {
      const successValue = status.toLowerCase() === 'true' ? 1 : status.toLowerCase() === 'false' ? 0 : null;
      if (successValue !== null) { whereClauses.push(`c.success = ?`); params.push(successValue); }
    }

    params.push(limit + 1, (page - 1) * limit);
    const sql = `SELECT r.timestamp,
      MAX(COALESCE(c.success, 0)) as success,
      r.model, r.provider,
      r.process_time as processTime, r.first_response_time as firstResponseTime,
      r.prompt_tokens as promptTokens, r.completion_tokens as completionTokens,
      r.total_tokens as totalTokens, r.text
      FROM request_stats r LEFT JOIN channel_stats c ON r.request_id = c.request_id
      WHERE ${whereClauses.join(' AND ')}
      GROUP BY r.request_id ORDER BY r.timestamp DESC
      LIMIT ? OFFSET ?`;

    const rows = queryRows({ sql, params });
    const hasNext = rows.length > limit;
    const logs = rows.slice(0, limit).map((row) => ({
      ...row,
      success: Number(row.success) === 1,
    }));
    return NextResponse.json({ logs, hasNextPage: hasNext });
  } catch (e: any) {
    return NextResponse.json(e.body || { error: e.message }, { status: e.status || 500 });
  }
}
