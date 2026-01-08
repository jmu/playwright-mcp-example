import { env } from 'cloudflare:workers';
import { jwtVerify, createRemoteJWKSet } from 'jose';

import { createMcpAgent } from '@cloudflare/playwright-mcp';

export const PlaywrightMCP = createMcpAgent(env.BROWSER);

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

    const { url } = await request.json();

    if (!url) {
      return new Response('Missing url parameter', { status: 400 });
    }

    console.log(`Fetching URL: ${url} for user: ${verification.payload.email}`);

    // Try simple fetch first (faster than browser)
    const response = await fetch(url);
    const html = await response.text();

    // Extract text content from HTML (simple regex-based)
    const textContent = html
      .replace(/<script[^>]*>.*?<\/script>/gis, '')
      .replace(/<style[^>]*>.*?<\/style>/gis, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    console.log(`Content length: ${textContent.length}`);

    return new Response(JSON.stringify({
      success: true,
      url,
      content: textContent.slice(0, 10000), // Limit to 10k chars
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
