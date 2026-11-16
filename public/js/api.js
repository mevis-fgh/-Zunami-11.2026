const TOKEN_KEY = 'gqlcov.adminToken';
const PROXY_KEY = 'gqlcov.proxyKey';

export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {any} [payload]
   */
  constructor(status, message, payload) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

export function getAdminToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function setAdminToken(value) {
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* localStorage может быть недоступен */
  }
}

export function getProxyKey() {
  try {
    return localStorage.getItem(PROXY_KEY) || '';
  } catch {
    return '';
  }
}

export function setProxyKey(value) {
  try {
    if (value) localStorage.setItem(PROXY_KEY, value);
    else localStorage.removeItem(PROXY_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * @param {string} path
 * @param {{ method?: string, body?: any, headers?: Record<string,string>, signal?: AbortSignal }} [options]
 */
export async function api(path, { method = 'GET', body, headers = {}, signal } = {}) {
  const finalHeaders = { accept: 'application/json', ...headers };
  const token = getAdminToken();
  if (token) finalHeaders['x-admin-token'] = token;

  let payload;
  if (body !== undefined) {
    if (typeof body === 'string') {
      payload = body;
      if (!finalHeaders['content-type']) finalHeaders['content-type'] = 'text/plain; charset=utf-8';
    } else {
      payload = JSON.stringify(body);
      if (!finalHeaders['content-type']) finalHeaders['content-type'] = 'application/json';
    }
  }

  const response = await fetch(path, {
    method,
    headers: finalHeaders,
    body: payload,
    signal,
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const message =
      (data && typeof data === 'object' && (data.error?.message || data.errors?.[0]?.message)) ||
      `HTTP ${response.status}`;
    throw new ApiError(response.status, message, data);
  }
  return data;
}

export function post(path, body) {
  return api(path, { method: 'POST', body });
}

export function patch(path, body) {
  return api(path, { method: 'PATCH', body });
}

export function del(path) {
  return api(path, { method: 'DELETE' });
}
