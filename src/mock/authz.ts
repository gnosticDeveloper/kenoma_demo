import { parseJwtClaims, type JwtClaims } from '../auth'
import { ApiError } from '../api/client'

export function requireClaims(token: string): JwtClaims {
  let claims: JwtClaims
  try {
    claims = parseJwtClaims(token)
  } catch {
    throw new ApiError(401, 'Unauthorized', '')
  }
  if (claims.exp * 1000 < Date.now()) throw new ApiError(401, 'Unauthorized', '')
  return claims
}

export function requireRole(token: string, ...anyOf: string[]): JwtClaims {
  const claims = requireClaims(token)
  const held = Object.values(claims.roles).flat()
  if (!anyOf.some(r => held.includes(r))) throw new ApiError(403, 'Forbidden', '')
  return claims
}

export function notFound(): never {
  throw new ApiError(404, 'Not Found', '')
}
