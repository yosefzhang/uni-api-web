import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
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

function decodeHeader(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, 'base64').toString('utf-8'));
  } catch {
    return null;
  }
}

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
    const engine = body.engine || '';
    const requestedEndpoint = body.endpoint === 'responses' ? 'responses' : body.endpoint === 'messages' ? 'messages' : 'chat/completions';
    const baseUrl = body.baseUrl || '';
    let url: string;
    let effectiveEndpoint: 'chat/completions' | 'responses' | 'messages';
    if (engine) {
      if (!baseUrl) {
        url = UNI_API_BASE_URL;
      } else if (baseUrl.startsWith('/')) {
        url = UNI_API_BASE_URL.replace(/\/v1$/, '') + baseUrl.replace(/\/+$/, '');
      } else {
        url = baseUrl.replace(/\/+$/, '');
      }
      if (url.endsWith('/responses')) {
        effectiveEndpoint = 'responses';
      } else if (url.endsWith('/messages')) {
        effectiveEndpoint = 'messages';
      } else {
        effectiveEndpoint = 'chat/completions';
      }
    } else {
      const endpoint = requestedEndpoint;
      let root: string;
      if (!baseUrl) {
        root = UNI_API_BASE_URL.replace(/\/v1$/, '');
      } else if (baseUrl.startsWith('/')) {
        root = UNI_API_BASE_URL.replace(/\/v1$/, '') + normalizeBaseRoot(baseUrl);
      } else {
        root = normalizeBaseRoot(baseUrl);
      }
      url = `${root}/${endpoint}`;
      effectiveEndpoint = endpoint;
    }
    const testText = '真实测试，请回复 ok';
    const requestBody: any = effectiveEndpoint === 'responses'
      ? { model, input: [{ role: 'user', content: [{ type: 'input_text', text: testText }] }] }
      : { model, messages: [{ role: 'user', content: testText }] };

    const channelApi = channelKey(api);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (effectiveEndpoint === 'messages') {
      headers['x-api-key'] = channelApi;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = `Bearer ${channelApi}`;
    }
    if (url.includes('opencode.ai') && url.includes('/zen/go')) {
      if (!headers['x-opencode-session']) {
        headers['x-opencode-session'] = crypto.randomUUID().replace(/-/g, '');
      }
      if (!headers['user-agent']) {
        headers['user-agent'] = 'uni-api-web';
      }
    }

    const requestInfo = { method: 'POST', url, headers, body: requestBody };
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...headers, 'x-uni-api-debug': '1' },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(60000),
      });
      const status = res.status;
      const upstreamRequest = decodeHeader(res.headers.get('x-uni-api-upstream-request'));
      const upstreamResponse = decodeHeader(res.headers.get('x-uni-api-upstream-response'));
      const text = await res.text();
      const elapsed = (Date.now() - started) / 1000;
      const success = status >= 200 && status < 300;
      const payload: any = {
        success,
        message: success ? '测试成功' : `HTTP ${status}`,
        responseTime: elapsed,
        request: requestInfo,
        response: { status, body: text },
      };
      if (upstreamRequest && upstreamResponse) {
        payload.upstream = { request: upstreamRequest, response: upstreamResponse };
      }
      return NextResponse.json(payload);
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
