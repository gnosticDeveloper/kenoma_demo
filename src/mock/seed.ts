import type { OrgResponse, OrgUnitResponse } from '../types'
import type { Db, StoredUser } from './db'
import { nowIso, uid } from './db'
import { seedBimeCatalog, type DemoLang } from './presets'

// Built-in metric units plus the generic count unit, mirroring the backend's standard set.
const STANDARD_UNITS = ['units', 'kg', 'g', 'm', 'cm', 'l', 'ml']

function seedUnits(db: Db, orgId: string): void {
  const rows: OrgUnitResponse[] = STANDARD_UNITS.map(name => ({
    id: uid(), orgId, name, standard: true, createdAt: nowIso(),
  }))
  db.units.push(...rows)
}

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
    { orgName: 'Thimble & Thread (Clothing)', contactEmail: 'owner@thimbleandthread.example', ownerName: 'Morgan', ownerLastName: 'Ibarra', username: 'morgan', preset: 'CLOTHING_STORE' },
    { orgName: 'CircuitFix Repair', contactEmail: 'owner@circuitfix.example', ownerName: 'Sam', ownerLastName: 'Okafor', username: 'sam', preset: 'REPAIR_SHOP' },
  ],
  es: [
    { orgName: 'Librería Umbral (Librería)', contactEmail: 'duena@libreriaumbral.example', ownerName: 'Valentina', ownerLastName: 'Rojas', username: 'valentina', preset: 'BOOK_STORE' },
    { orgName: 'Hilo & Trama (Indumentaria)', contactEmail: 'dueno@hiloytrama.example', ownerName: 'Mateo', ownerLastName: 'Duarte', username: 'mateo', preset: 'CLOTHING_STORE' },
    { orgName: 'Circuito Sur (Reparaciones)', contactEmail: 'duena@circuitosur.example', ownerName: 'Camila', ownerLastName: 'Ferreyra', username: 'camila', preset: 'REPAIR_SHOP' },
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
    units: [],
    uomConversions: [],
    barcodes: [],
    batches: [],
    transfers: [],
    sales: [],
    orgBarcodeSettings: [],
    orgBatchSettings: [],
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

    seedUnits(db, orgId)
    seedBimeCatalog(db, orgId, shop.preset, lang)
  }

  return db
}
