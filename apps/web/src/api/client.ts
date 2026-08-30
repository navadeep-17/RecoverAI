const baseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

export async function getJson<T>(path: string): Promise<T> {
  // DEV / HACKATHON ADAPTER ONLY. These headers are not production authentication.
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      'x-merchant-id': import.meta.env.VITE_DEV_MERCHANT_ID || '',
      'x-user-id': import.meta.env.VITE_DEV_USER_ID || '',
      'x-user-role': import.meta.env.VITE_DEV_USER_ROLE || 'MERCHANT_ADMIN',
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, typeof body.error === 'string' ? body.error : `Request failed (${response.status})`);
  return body as T;
}
