
export interface Route {
  orgId: string | null
  page: string | null
}

export function parseRoute(pathname: string): Route {
  const [orgId = null, page = null] = pathname.split('/').filter(Boolean)
  return { orgId, page }
}

export function buildPath(orgId: string, page?: string): string {
  return page ? `/${orgId}/${page}` : `/${orgId}`
}
