import { env, WorkerEntrypoint } from 'cloudflare:workers';
import { jwtVerify, createRemoteJWKSet } from 'jose';

import { createMcpAgent } from '@cloudflare/playwright-mcp';

export const PlaywrightMCP = createMcpAgent(env.BROWSER);

type FetchResult = {
  url: string;
  content: string;
};

// Verify Cloudflare Access JWT
async function verifyJWT(request: Request, env: Env): Promise<{ valid: boolean; payload?: any }> {
  const token = request.headers.get('cf-access-jwt-assertion');

  if (!token) {
    return { valid: false };
  }

  try {
    const JWKS = createRemoteJWKSet(
      new URL(`${env.TEAM_DOMAIN}/cdn-cgi/access/certs`)
    );

    const { payload } = await jwtVerify(token, JWKS, {
      issuer: env.TEAM_DOMAIN,
      audience: env.POLICY_AUD,
    });

    return { valid: true, payload };
  } catch (error) {
    console.error('JWT verification failed:', error);
    return { valid: false };
  }
}

function normalizeUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Missing url parameter');
  }

  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS URLs are supported');
  }

  return url.toString();
}

function extractTextContent(html: string): string {
  return html
    .replace(/<script[^>]*>.*?<\/script>/gis, '')
    .replace(/<style[^>]*>.*?<\/style>/gis, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 10000);
}

async function fetchContent(urlValue: unknown): Promise<FetchResult> {
  const url = normalizeUrl(urlValue);
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Upstream fetch failed: ${response.status}`);
  }

  const html = await response.text();
  return {
    url,
    content: extractTextContent(html),
  };
}

// Private RPC entrypoint for Workers on the same Cloudflare account.
// Access to this class is granted by a Service Binding, not by an end-user JWT.
export class ContentFetcher extends WorkerEntrypoint<Env> {
  async fetchContent(url: string): Promise<FetchResult> {
    console.log(`Fetching URL through internal service binding: ${url}`);
    return fetchContent(url);
  }
}

// Simple REST endpoint to fetch webpage content (using fetch, not browser)
async function handleFetch(request: Request, env: Env): Promise<Response> {
  // Verify JWT first
  const verification = await verifyJWT(request, env);
  if (!verification.valid) {
    return new Response('Unauthorized: Invalid or missing JWT', {
      status: 401,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  try {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const { url } = await request.json() as { url?: unknown };
    const result = await fetchContent(url);

    console.log(`Fetched ${result.content.length} chars for user: ${verification.payload.email}`);

    return new Response(JSON.stringify({
      success: true,
      ...result,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Fetch error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const { pathname } = new URL(request.url);

    // Health check endpoint (no auth required)
    if (pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        message: 'MCP service is running with Cloudflare Access',
        endpoints: ['/fetch', '/sse', '/mcp', '/health']
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    switch (pathname) {
      case '/fetch':
        return handleFetch(request, env);
      case '/sse':
      case '/sse/message':
        return PlaywrightMCP.serveSSE('/sse').fetch(request, env, ctx);
      case '/mcp':
        return PlaywrightMCP.serve('/mcp').fetch(request, env, ctx);
      default:
        return new Response('Not Found', { status: 404 });
    }
  },
};
