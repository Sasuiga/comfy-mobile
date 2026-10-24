import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from './errors.js';

function tokenEquals(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function extractAuthToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (typeof header === 'string' && /^Bearer\s+/i.test(header)) {
    return header.replace(/^Bearer\s+/i, '').trim();
  }
  const alt = request.headers['x-auth-token'];
  if (typeof alt === 'string') return alt.trim();
  const cookie = request.headers.cookie;
  if (typeof cookie === 'string') {
    for (const part of cookie.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === 'comfy_mobile_token') return decodeURIComponent(rest.join('='));
    }
  }
  return '';
}

export function requireAuth(expectedToken: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!expectedToken) return;
    const actual = extractAuthToken(request);
    if (!actual || !tokenEquals(actual, expectedToken)) {
      reply.header('WWW-Authenticate', 'Bearer');
      throw new AppError(401, 'UNAUTHORIZED', '访问令牌不正确');
    }
  };
}

export function sameOriginGuard() {
  return async (request: FastifyRequest): Promise<void> => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
    const origin = request.headers.origin;
    if (!origin) return;
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      throw new AppError(403, 'BAD_ORIGIN', '请求来源不合法');
    }
    const forwarded = request.headers['x-forwarded-host'];
    const expectedHosts = new Set<string>();
    if (request.headers.host) expectedHosts.add(String(request.headers.host));
    if (typeof forwarded === 'string') {
      for (const host of forwarded.split(',')) expectedHosts.add(host.trim());
    }
    if (!expectedHosts.has(originHost)) {
      throw new AppError(403, 'BAD_ORIGIN', '拒绝跨站请求');
    }
  };
}

export function safeFilename(name: string, fallback = 'file'): string {
  const base = name.split(/[\\/]/).pop() || fallback;
  const cleaned = base
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || fallback).slice(0, 180);
}

export function validateRemoteWorkflowPath(path: string): string {
  if (!path || path.length > 1024) {
    throw new AppError(400, 'INVALID_WORKFLOW_PATH', '工作流路径不合法');
  }
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\u0000') ||
    path.split('/').some((part) => part === '..' || part === '.' || part === '')
  ) {
    throw new AppError(400, 'INVALID_WORKFLOW_PATH', '工作流路径不合法');
  }
  if (!path.endsWith('.json')) {
    throw new AppError(400, 'INVALID_WORKFLOW_PATH', '只支持 JSON 工作流文件');
  }
  return path;
}

export function workflowKey(source: 'remote' | 'imported', path: string): string {
  return `${source === 'remote' ? 'u' : 'i'}:${Buffer.from(path, 'utf8').toString('base64url')}`;
}

export function decodeWorkflowKey(key: string): { source: 'remote' | 'imported'; path: string } {
  if (key.startsWith('u:')) {
    const path = Buffer.from(key.slice(2), 'base64url').toString('utf8');
    return { source: 'remote', path: validateRemoteWorkflowPath(path) };
  }
  if (key.startsWith('i:')) {
    const path = Buffer.from(key.slice(2), 'base64url').toString('utf8');
    // Imported file names keep the title the user typed, usually Chinese, so
    // this has to accept Unicode letters and digits (see importWorkflow).
    if (!/^[\p{L}\p{N}._-]+\.json$/u.test(path)) {
      throw new AppError(400, 'INVALID_WORKFLOW_KEY', '导入工作流标识不合法');
    }
    return { source: 'imported', path };
  }
  throw new AppError(400, 'INVALID_WORKFLOW_KEY', '工作流标识不合法');
}

export function shortHash(value: string, length = 16): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

export function encodePathSegments(path: string): string {
  return path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}
