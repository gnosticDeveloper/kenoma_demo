import type { RoleResponse } from '../types'

export const RAUM_ROLES: RoleResponse[] = [
  {
    name: 'RAUM_ADMIN',
    displayName: 'Platform Administrator',
    description: 'Operates the platform itself: manages every organization, registered services, database credentials, and pricing configuration.',
  },
  {
    name: 'RAUM_ONBOARDING',
    displayName: 'Onboarding Operator',
    description: 'Can initiate onboarding of new organizations.',
  },
  {
    name: 'RAUM_OWNER',
    displayName: 'Organization Owner',
    description: "Can request and download an export of this organization's own data, for backup or offboarding.",
  },
]

export const VASSAGO_ROLES: RoleResponse[] = [
  {
    name: 'VASSAGO_ADMIN',
    displayName: 'Account Administrator',
    description: 'Can create, view, edit, and offboard any user in the organization.',
  },
  {
    name: 'VASSAGO_MEMBER',
    displayName: 'Account Member',
    description: 'Can view every user in the organization, and edit their own profile.',
  },
]

export const BIME_ROLES: RoleResponse[] = [
  {
    name: 'BIME_ADMIN',
    displayName: 'Inventory Administrator',
    description: 'Full control over products, stock, and locations.',
  },
  {
    name: 'BIME_VIEWER',
    displayName: 'Inventory Viewer',
    description: 'Can view products, stock, and locations without making changes.',
  },
  {
    name: 'BIME_CATALOG_VIEWER',
    displayName: 'Catalog Browser',
    description: 'Can only browse the product catalog, without visibility into stock levels or locations.',
  },
]
