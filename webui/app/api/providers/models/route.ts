import { NextRequest, NextResponse } from 'next/server';
import { requireKey } from '@/lib/status-config';

function baseUrlToModelsUrl(baseUrl: string): string {
  let root = baseUrl.replace(/\/+$/, '');
  for (const suffix of ['/chat/completions', '/completions', '/responses', '/messages']) {
    if (root.endsWith(suffix)) {
      root = root.slice(0, -suffix.length);
      break;
    }
  }
  return `${root}/models`;
}

function channelKey(api: any): string {
  if (typeof api === 'string') return api;
  if (Array.isArray(api)) {
    const first = api[0];
    if (typeof first === 'string') return first;
    if (first?.api) return first.api;
  }
  return '';
}

function extractModelIds(data: any): any[] {
  const candidates = [data?.data, data?.models, Array.isArray(data) ? data : null];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.map((item: any) => {
        if (typeof item === 'string') return item;
        return item?.id;
      }).filter(Boolean);
    }
  }
  return [];
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const apiKey = body.apiKey;
    const baseUrl = body.base_url;
    const api = body.api;
    if (!apiKey || !baseUrl || !api) {
      return NextResponse.json({ success: false, message: '缺少必要参数' });
    }
    requireKey(apiKey);
    const channelApi = channelKey(api);
    if (!channelApi) {
      return NextResponse.json({ success: false, message: '渠道未配置 API Key' });
    }
    const url = baseUrlToModelsUrl(baseUrl);
    const headers: Record<string, string> = {};
    if (baseUrl.includes('/v1/messages')) {
      headers['x-api-key'] = channelApi;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = `Bearer ${channelApi}`;
    }
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return NextResponse.json({ success: false, message: `HTTP ${res.status}: ${text.slice(0, 200)}` });
    }
    const data = await res.json();
    return NextResponse.json({ success: true, models: extractModelIds(data) });
  } catch (e: any) {
    return NextResponse.json({ success: false, message: `网络错误: ${e.message}` });
  }
}
