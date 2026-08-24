const SESSION_KEY = 'kenoma-demo-session'
const TOKEN_TTL_SECONDS = 15 * 60

interface SessionPointer {
  userId: string
  orgId: string
}

function b64urlEncode(value: unknown): string {
  const json = JSON.stringify(value)
  const b64 = btoa(unescape(encodeURIComponent(json)))
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function mintToken(userId: string, orgId: string, roles: Record<string, string[]>): string {
  const header = b64urlEncode({ alg: 'none', typ: 'JWT' })
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS
  const payload = b64urlEncode({ sub: userId, orgId, roles, exp })
  return `${header}.${payload}.demo-signature`
}

export function rememberSession(userId: string, orgId: string): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ userId, orgId } satisfies SessionPointer))
}

export function readSession(): SessionPointer | null {
  const raw = localStorage.getItem(SESSION_KEY)
  if (!raw) return null
  try { return JSON.parse(raw) as SessionPointer } catch { return null }
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY)
}
