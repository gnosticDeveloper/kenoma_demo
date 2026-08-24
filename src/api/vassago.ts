import type { LoginRequest, RoleResponse, UserRequest, UserResponse } from '../types'
import { ApiError } from './client'
import { delay, getDb, persist, uid } from '../mock/db'
import { requireClaims, requireRole, notFound } from '../mock/authz'
import { mintToken, rememberSession, readSession, clearSession } from '../mock/session'
import { VASSAGO_ROLES } from '../mock/roles'

function toResponse(u: { id: string; name: string; lastName: string; email: string; username: string; roles: Record<string, string[]> }): UserResponse {
  return { id: u.id, name: u.name, lastName: u.lastName, email: u.email, username: u.username, roles: u.roles }
}

export const vassago = {
  login: async (dto: LoginRequest): Promise<{ token: string }> => {
    await delay()
    const db = getDb()
    const user = db.users.find(u => u.orgId === dto.orgId && u.username === dto.username && u.password === dto.password)
    if (!user) throw new ApiError(401, 'Unauthorized', 'Invalid organization, username, or password.')
    rememberSession(user.id, user.orgId)
    return { token: mintToken(user.id, user.orgId, user.roles) }
  },

  refresh: async (): Promise<{ token: string }> => {
    await delay()
    const session = readSession()
    if (!session) throw new ApiError(401, 'Unauthorized', '')
    const db = getDb()
    const user = db.users.find(u => u.id === session.userId && u.orgId === session.orgId)
    if (!user) throw new ApiError(401, 'Unauthorized', '')
    return { token: mintToken(user.id, user.orgId, user.roles) }
  },

  logout: async (_token: string): Promise<void> => {
    await delay()
    clearSession()
  },

  publicKey: async (): Promise<{ publicKey: string }> => {
    await delay()
    return {
      publicKey:
        '-----BEGIN PUBLIC KEY-----\n' +
        'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEDEMO0KEYDEMO0KEYDEMO0KEYDEMO\n' +
        '0KEYDEMO0KEYDEMO0KEYDEMO0KEYDEMO0KEYDEMO0KEYDEMO0KEYDEMO0KEYDEM=\n' +
        '-----END PUBLIC KEY-----',
    }
  },

  recover: async (_dto: { orgId: string; username: string }): Promise<void> => {
    await delay()
  },

  roles: async (token: string): Promise<RoleResponse[]> => {
    await delay()
    requireClaims(token)
    return VASSAGO_ROLES
  },

  users: {
    list: async (token: string): Promise<UserResponse[]> => {
      await delay()
      const claims = requireRole(token, 'VASSAGO_ADMIN', 'VASSAGO_MEMBER')
      const db = getDb()
      return db.users.filter(u => u.orgId === claims.orgId).map(toResponse)
    },

    get: async (id: string, token: string): Promise<UserResponse> => {
      await delay()
      const claims = requireRole(token, 'VASSAGO_ADMIN', 'VASSAGO_MEMBER')
      const db = getDb()
      const user = db.users.find(u => u.id === id && u.orgId === claims.orgId)
      if (!user) notFound()
      return toResponse(user)
    },

    create: async (dto: UserRequest, token: string): Promise<UserResponse> => {
      await delay()
      const claims = requireRole(token, 'VASSAGO_ADMIN')
      const db = getDb()
      const user = {
        id: uid(), orgId: claims.orgId, name: dto.name, lastName: dto.lastName,
        email: dto.email, username: dto.username, password: 'demo1234', roles: dto.roles,
      }
      db.users.push(user)
      persist()
      return toResponse(user)
    },

    update: async (id: string, dto: UserRequest, token: string): Promise<UserResponse> => {
      await delay()
      const claims = requireRole(token, 'VASSAGO_ADMIN', 'VASSAGO_MEMBER')
      const db = getDb()
      const user = db.users.find(u => u.id === id && u.orgId === claims.orgId)
      if (!user) notFound()
      user.name = dto.name
      user.lastName = dto.lastName
      user.email = dto.email
      user.username = dto.username
      user.roles = dto.roles
      persist()
      return toResponse(user)
    },

    offboard: async (id: string, token: string): Promise<void> => {
      await delay()
      const claims = requireRole(token, 'VASSAGO_ADMIN')
      const db = getDb()
      const idx = db.users.findIndex(u => u.id === id && u.orgId === claims.orgId)
      if (idx === -1) notFound()
      db.users.splice(idx, 1)
      persist()
    },

    verify: async (_dto: { orgId: string; token: string; newPassword: string }): Promise<void> => {
      await delay()
    },

    changePassword: async (oldPassword: string, token: string): Promise<void> => {
      await delay()
      const claims = requireClaims(token)
      const db = getDb()
      const user = db.users.find(u => u.id === claims.sub)
      if (!user || user.password !== oldPassword) throw new ApiError(400, 'Bad Request', 'Current password is incorrect.')
    },
  },
}
