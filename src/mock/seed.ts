import type {
  OrgResponse,
  OrgUnitResponse,
  ProductVariantResponse,
  SaleLineResponse,
  UomConversionResponse,
} from '../types'
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

// Org-defined units (packs, crates, ...) on top of the standard set.
function seedCustomUnits(db: Db, orgId: string, names: string[]): void {
  for (const name of names) {
    if (db.units.some(u => u.orgId === orgId && u.name.toLowerCase() === name.toLowerCase())) continue
    db.units.push({ id: uid(), orgId, name, standard: false, createdAt: nowIso() })
  }
}

// Attach a pack-size conversion to one variant so the "sold as a pack" path,
// the products-page UOM editor and pack-priced barcodes have data to show.
function seedUomConversion(
  db: Db, orgId: string, variantId: string, uomName: string, factor: number, price?: number,
): void {
  const variant = db.variants.find(v => v.id === variantId)
  if (!variant) return
  const effectivePrice = price ?? (variant.price != null ? Math.round(variant.price * factor * 100) / 100 : null)
  const row: UomConversionResponse = {
    id: uid(), orgId, variantId, uomName, factor,
    price: price ?? null, effectivePrice,
    createdAt: nowIso(), modifiedAt: nowIso(),
  }
  db.uomConversions.push(row)
  variant.uomConversions = db.uomConversions.filter(c => c.variantId === variantId)
}

// ── Seeded point-of-sale history ────────────────────────────────────────────

function findVariant(db: Db, orgId: string, sku: string): ProductVariantResponse | undefined {
  return db.variants.find(v => v.orgId === orgId && v.sku === sku)
}

function depleteForSale(
  db: Db, orgId: string, variant: ProductVariantResponse, locationId: string,
  qtyBase: number, saleId: string, uom: string | null, uomQty: number, soldAt: string,
): void {
  const bal = db.stockBalances.find(b => b.variantId === variant.id && b.locationId === locationId)
  if (bal) {
    bal.quantity -= qtyBase
    bal.modifiedAt = soldAt
  }
  const product = db.products.find(p => p.id === variant.productId)
  if (product?.tracksBatches) {
    let remaining = qtyBase
    const lots = db.batches
      .filter(b => b.orgId === orgId && b.variantId === variant.id && b.status === 'ACTIVE')
      .filter(b => (b.balances.find(x => x.locationId === locationId)?.quantity ?? 0) > 0)
      .sort((a, b) => (a.expiryDate ?? '9999').localeCompare(b.expiryDate ?? '9999'))
    for (const lot of lots) {
      if (remaining <= 0) break
      const cell = lot.balances.find(x => x.locationId === locationId)!
      const take = Math.min(remaining, cell.quantity)
      cell.quantity -= take
      remaining -= take
    }
  }
  db.stockMovements.push({
    id: uid(), orgId, productId: variant.productId, variantId: variant.id, locationId,
    movementType: 'SALE', status: 'POSTED', delta: -qtyBase,
    uom: uom ?? null, uomQuantity: uom ? -uomQty : null,
    referenceId: saleId, note: null, createdAt: soldAt, createdBy: 'system',
    batchId: null, allocations: null,
  })
}

// A handful of completed sales per org, spread over the last few days, so the
// point-of-sale "recent sales" list and the SALE ledger entries aren't empty.
function seedDemoSales(db: Db, orgId: string, count: number): void {
  const locations = db.locations.filter(l => l.orgId === orgId)
  if (locations.length === 0) return
  const sellable = db.variants.filter(v =>
    v.orgId === orgId && v.isActive && v.price != null
    && db.stockBalances.some(b => b.variantId === v.id && b.quantity > 4))
  if (sellable.length === 0) return

  for (let s = 0; s < count; s++) {
    const location = locations[s % locations.length]
    const saleId = uid()
    // Newest first: sale 0 is ~a day ago, each older one another ~26h back.
    const soldAt = new Date(Date.now() - (s + 1) * 26 * 3_600_000 - (s * 41) * 60_000).toISOString()
    const lineCount = 1 + ((s + 1) % 3)
    const lines: SaleLineResponse[] = []
    let currency: string | null = null

    for (let li = 0; li < lineCount; li++) {
      const variant = sellable[(s * 3 + li * 5) % sellable.length]
      const bal = db.stockBalances.find(b => b.variantId === variant.id && b.locationId === location.id && b.quantity > 4)
      if (!bal) continue

      const conv = db.uomConversions.find(c => c.variantId === variant.id)
      const usePack = conv != null && li === 0 && s % 2 === 0 && bal.quantity > conv.factor + 4
      const uom = usePack ? conv!.uomName : null
      const factor = usePack ? conv!.factor : 1
      const uomQty = usePack ? 1 : 1 + ((li + s) % 3)
      const qtyBase = uomQty * factor
      if (bal.quantity - qtyBase < 2) continue

      const unitPrice = usePack
        ? (conv!.effectivePrice ?? variant.price! * factor)
        : variant.price!
      const lineTotal = Math.round(unitPrice * uomQty * 100) / 100
      currency = currency ?? variant.priceCurrency ?? null

      lines.push({
        id: uid(), variantId: variant.id, barcode: null,
        qtyBase, uom, uomQuantity: uom ? uomQty : null,
        unitPrice, lineTotal,
      })
      depleteForSale(db, orgId, variant, location.id, qtyBase, saleId, uom, uomQty, soldAt)
    }

    if (lines.length === 0) continue
    const subtotal = Math.round(lines.reduce((n, l) => n + l.lineTotal, 0) * 100) / 100
    db.sales.push({
      id: saleId, orgId, locationId: location.id,
      reference: `POS-${1000 + s}`,
      status: 'COMPLETED', subtotal, currency, note: null,
      lines, soldAt, soldBy: 'system', voidedAt: null, voidedBy: null,
    })
  }
}

// ── Shops ───────────────────────────────────────────────────────────────────

interface ShopBlueprint {
  orgName: string
  contactEmail: string
  ownerName: string
  ownerLastName: string
  username: string
  preset: 'BOOK_STORE' | 'CLOTHING_STORE' | 'REPAIR_SHOP' | 'GROCERY_STORE'
  customUnits?: string[]
}

const SHOPS_BY_LANG: Record<DemoLang, ShopBlueprint[]> = {
  en: [
    { orgName: 'Chapter & Verse Books', contactEmail: 'owner@chapterandverse.example', ownerName: 'Avery', ownerLastName: 'Lund', username: 'avery', preset: 'BOOK_STORE' },
    { orgName: 'Thimble & Thread (Clothing)', contactEmail: 'owner@thimbleandthread.example', ownerName: 'Morgan', ownerLastName: 'Ibarra', username: 'morgan', preset: 'CLOTHING_STORE', customUnits: ['case'] },
    { orgName: 'CircuitFix Repair', contactEmail: 'owner@circuitfix.example', ownerName: 'Sam', ownerLastName: 'Okafor', username: 'sam', preset: 'REPAIR_SHOP' },
    { orgName: 'Bramble & Bell Grocers', contactEmail: 'owner@brambleandbell.example', ownerName: 'Nadia', ownerLastName: 'Whitlock', username: 'nadia', preset: 'GROCERY_STORE', customUnits: ['case', 'crate', 'dozen'] },
  ],
  es: [
    { orgName: 'Librería Umbral (Librería)', contactEmail: 'duena@libreriaumbral.example', ownerName: 'Valentina', ownerLastName: 'Rojas', username: 'valentina', preset: 'BOOK_STORE' },
    { orgName: 'Hilo & Trama (Indumentaria)', contactEmail: 'dueno@hiloytrama.example', ownerName: 'Mateo', ownerLastName: 'Duarte', username: 'mateo', preset: 'CLOTHING_STORE', customUnits: ['cajón'] },
    { orgName: 'Circuito Sur (Reparaciones)', contactEmail: 'duena@circuitosur.example', ownerName: 'Camila', ownerLastName: 'Ferreyra', username: 'camila', preset: 'REPAIR_SHOP' },
    { orgName: 'Mercado La Higuera (Almacén)', contactEmail: 'duena@mercadolahiguera.example', ownerName: 'Renata', ownerLastName: 'Salgado', username: 'renata', preset: 'GROCERY_STORE', customUnits: ['cajón', 'docena', 'pack'] },
  ],
}

// Pack-size conversions wired onto specific seeded variants, by SKU. The unit
// must already exist for the org (see each shop's customUnits above).
function seedExtras(db: Db, orgId: string, shop: ShopBlueprint): void {
  if (shop.preset === 'CLOTHING_STORE') {
    const v = findVariant(db, orgId, 'CLO-001-1')
    const unit = db.units.find(u => u.orgId === orgId && !u.standard)?.name
    if (v && unit) seedUomConversion(db, orgId, v.id, unit, 6)
  }
  if (shop.preset === 'GROCERY_STORE') {
    const eggs = findVariant(db, orgId, 'GRO-003-1')
    const dozenUnit = db.units.find(u => u.orgId === orgId && /doc|doz/i.test(u.name))?.name
    if (eggs && dozenUnit) seedUomConversion(db, orgId, eggs.id, dozenUnit, 12)

    const milk = findVariant(db, orgId, 'GRO-001-2')
    const caseUnit = db.units.find(u => u.orgId === orgId && /case|caj/i.test(u.name))?.name
    if (milk && caseUnit && milk.price != null) {
      // Case of 12 at roughly an 8% bulk discount.
      seedUomConversion(db, orgId, milk.id, caseUnit, 12, Math.round(milk.price * 11 * 100) / 100)
    }
  }
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
    if (shop.customUnits) seedCustomUnits(db, orgId, shop.customUnits)
    seedBimeCatalog(db, orgId, shop.preset, lang)
    seedExtras(db, orgId, shop)
    seedDemoSales(db, orgId, shop.preset === 'GROCERY_STORE' ? 6 : 4)
  }

  return db
}
