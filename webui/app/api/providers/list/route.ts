import { NextRequest, NextResponse } from 'next/server';
import { requireKey, readConfig } from '@/lib/status-config';

export async function GET(request: NextRequest) {
  try {
    const apiKey = request.nextUrl.searchParams.get('apiKey');
    requireKey(apiKey);
    const { config } = readConfig();
    const providers = (config.providers || []).map((p: any) => {
      const models: any[] = [];
      for (const entry of (p.model || [])) {
        if (typeof entry === 'string') {
          models.push({ original: entry, display: entry });
        } else if (typeof entry === 'object') {
          for (const [original, display] of Object.entries(entry)) {
            models.push({ original, display });
          }
        }
      }
      const baseUrl = p.base_url || '';
      const supported = baseUrl.includes('/chat/completions') || baseUrl.includes('/v1/messages') || baseUrl.includes('/responses');
      return {
        provider: p.provider || null,
        base_url: baseUrl,
        api: p.api || null,
        models,
        supported,
      };
    });
    const uniApiOrigin = process.env.UNI_API_BASE_URL || `${request.nextUrl.protocol}//${request.nextUrl.hostname}:8000/v1`;
    return NextResponse.json({ providers, uniApiBaseUrl: uniApiOrigin });
  } catch (e: any) {
    return NextResponse.json(e.body || { error: e.message }, { status: e.status || 500 });
  }
}
