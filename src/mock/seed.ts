import type { OrgResponse } from '../types'
import type { Db, StoredUser } from './db'
import { uid } from './db'
import { seedBimeCatalog, type DemoLang } from './presets'

interface ShopBlueprint {
  orgName: string
  contactEmail: string
  ownerName: string
  ownerLastName: string
  username: string
  preset: 'BOOK_STORE' | 'CLOTHING_STORE' | 'REPAIR_SHOP'
}

const SHOPS_BY_LANG: Record<DemoLang, ShopBlueprint[]> = {
  en: [
    { orgName: 'Chapter & Verse Books', contactEmail: 'owner@chapterandverse.example', ownerName: 'Avery', ownerLastName: 'Lund', username: 'avery', preset: 'BOOK_STORE' },
    { orgName: 'Thimble & Thread', contactEmail: 'owner@thimbleandthread.example', ownerName: 'Morgan', ownerLastName: 'Ibarra', username: 'morgan', preset: 'CLOTHING_STORE' },
    { orgName: 'CircuitFix Repair', contactEmail: 'owner@circuitfix.example', ownerName: 'Sam', ownerLastName: 'Okafor', username: 'sam', preset: 'REPAIR_SHOP' },
  ],
  es: [
    { orgName: 'Capítulo y Verso', contactEmail: 'duena@capituloyverso.example', ownerName: 'Valentina', ownerLastName: 'Rojas', username: 'valentina', preset: 'BOOK_STORE' },
    { orgName: 'Dedal y Aguja', contactEmail: 'dueno@dedalyaguja.example', ownerName: 'Mateo', ownerLastName: 'Duarte', username: 'mateo', preset: 'CLOTHING_STORE' },
    { orgName: 'ReparaFix', contactEmail: 'duena@reparafix.example', ownerName: 'Camila', ownerLastName: 'Ferreyra', username: 'camila', preset: 'REPAIR_SHOP' },
  ],
}

export function buildSeed(lang: DemoLang): Db {
  const orgs: OrgResponse[] = []
  const users: StoredUser[] = []

  const db: Db = {
    orgs,
    billingHistory: [],
    exportJobs: [],
    drBackups: [],
    basePricing: [],
    modulePricing: [],
    exchangeRates: [],
    services: [],
    users,
    locations: [],
    metadata: [],
    products: [],
    variants: [],
    stockMovements: [],
    stockBalances: [],
    alertThresholds: [],
  }

  for (const shop of SHOPS_BY_LANG[lang]) {
    const orgId = uid()
    const bimeSvcId = uid()

    orgs.push({ id: orgId, name: shop.orgName, contactEmail: shop.contactEmail })

    users.push({
      id: uid(), orgId, name: shop.ownerName, lastName: shop.ownerLastName,
      email: shop.contactEmail, username: shop.username, password: 'demo1234',
      roles: { [bimeSvcId]: ['BIME_ADMIN'] },
    })

    seedBimeCatalog(db, orgId, shop.preset, lang)
  }

  return db
}
