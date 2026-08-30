const baseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';

export class ApiError<T = unknown> extends Error { constructor(public status: number, message: string, public data?: T) { super(message); } }

export async function requestJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  // DEV / HACKATHON ADAPTER ONLY. These headers are not production authentication.
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      'x-merchant-id': import.meta.env.VITE_DEV_MERCHANT_ID || '',
      'x-user-id': import.meta.env.VITE_DEV_USER_ID || '',
      'x-user-role': import.meta.env.VITE_DEV_USER_ROLE || 'MERCHANT_ADMIN',
    }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, typeof responseBody.error === 'string' ? responseBody.error : `Request failed (${response.status})`, responseBody);
  return responseBody as T;
}
export function getJson<T>(path: string): Promise<T> { return requestJson<T>('GET', path); }
