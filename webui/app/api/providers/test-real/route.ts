import { NextRequest, NextResponse } from 'next/server';
import { requireKey, readConfig, findKey } from '@/lib/status-config';

function normalizeBaseRoot(baseUrl: string): string {
  let root = baseUrl.replace(/\/+$/, '');
  for (const suffix of ['/chat/completions', '/v1/messages', '/completions', '/responses', '/messages']) {
    if (root.endsWith(suffix)) {
      root = root.slice(0, -suffix.length);
      break;
    }
  }
  return root;
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

const UNI_API_BASE_URL = process.env.UNI_API_BASE_URL || 'http://localhost:8000/v1';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const apiKey = body.apiKey;
    const api = body.api;
    const model = body.model;
    if (!apiKey || !model || !api) {
      return NextResponse.json({ success: false, message: '缺少必要参数 (apiKey / api / model)' });
    }
    const { config } = readConfig();
    if (!findKey(config, apiKey)) {
      return NextResponse.json({ success: false, message: '未授权' });
    }
    const endpoint = body.endpoint === 'responses' ? 'responses' : body.endpoint === 'messages' ? 'messages' : 'chat/completions';
    const baseUrl = body.baseUrl || '';
    let root: string;
    if (!baseUrl) {
      root = UNI_API_BASE_URL.replace(/\/v1$/, '');
    } else if (baseUrl.startsWith('/')) {
      root = UNI_API_BASE_URL.replace(/\/v1$/, '') + normalizeBaseRoot(baseUrl);
    } else {
      root = normalizeBaseRoot(baseUrl);
    }
    const url = `${root}/${endpoint}`;
    const testText = '真实测试，请回复 ok';
    const requestBody: any = endpoint === 'responses'
      ? { model, input: [{ role: 'user', content: [{ type: 'input_text', text: testText }] }] }
      : { model, messages: [{ role: 'user', content: testText }] };

    const channelApi = channelKey(api);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (endpoint === 'messages') {
      headers['x-api-key'] = channelApi;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = `Bearer ${channelApi}`;
    }

    const requestInfo = { method: 'POST', url, headers, body: requestBody };
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(60000),
      });
      const status = res.status;
      const text = await res.text();
      const elapsed = (Date.now() - started) / 1000;
      const success = status >= 200 && status < 300;
      return NextResponse.json({
        success,
        message: success ? '测试成功' : `HTTP ${status}`,
        responseTime: elapsed,
        request: requestInfo,
        response: { status, body: text },
      });
    } catch (e: any) {
      const elapsed = (Date.now() - started) / 1000;
      const message = e.name === 'TimeoutError' ? '请求超时(60s)' : `网络错误: ${e.message}`;
      return NextResponse.json({
        success: false,
        message,
        responseTime: elapsed,
        request: requestInfo,
        response: { status: 0, body: '' },
      });
    }
  } catch (e: any) {
    return NextResponse.json({ success: false, message: e.message });
  }
}
