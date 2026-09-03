import type {
  BarcodeLookupResponse,
  BatchResponse,
  BatchStatus,
  InTransitStock,
  LocationRequest,
  LocationResponse,
  MetadataOptionPatch,
  MetadataOptionRequest,
  MetadataOptionResponse,
  MovementType,
  NotificationEmailVerifyRequest,
  OrgBarcodeSettingsRequest,
  OrgBarcodeSettingsResponse,
  OrgBatchSettingsRequest,
  OrgBatchSettingsResponse,
  OrgUnitRequest,
  OrgUnitResponse,
  ProductMetadataAssignmentItem,
  ProductMetadataRequest,
  ProductMetadataResponse,
  ProductRequest,
  ProductResponse,
  ProductVariantRequest,
  ProductVariantResponse,
  RecallReport,
  RecallRequest,
  RoleResponse,
  SaleLineResponse,
  SaleRequest,
  SaleResponse,
  StockAlertResponse,
  StockAlertThresholdRequest,
  StockAlertThresholdResponse,
  StockBalanceResponse,
  StockMovementRequest,
  StockMovementResponse,
  StockTransferRequest,
  StockTransferResponse,
  StockTransferLineResponse,
  StockTransferReceiveRequest,
  UomConversionRequest,
  UomConversionResponse,
  VariantBarcodeIssueRequest,
  VariantBarcodePrimaryRequest,
  VariantBarcodeRequest,
  VariantBarcodeResponse,
  VariantBatchCostRequest,
  VariantBatchPriceRequest,
} from '../types'
import { delay, getDb, nowIso, persist, uid, type BatchRecord, type Db } from '../mock/db'
import { requireClaims, requireRole, notFound } from '../mock/authz'
import { ApiError } from './client'
import { buildTextPdf } from '../lib/pdf'
import { renderSaleTicket } from '../lib/saleTicketPdf'
import { BIME_ROLES } from '../mock/roles'

const VIEW_ROLES = ['BIME_ADMIN', 'BIME_STOCK_OPERATOR', 'BIME_CASHIER', 'BIME_TRANSFER_APPROVER', 'BIME_VIEWER']
const MANAGE_ROLES = ['BIME_ADMIN', 'BIME_STOCK_OPERATOR']
const CATALOG_ROLES = [...VIEW_ROLES, 'BIME_CATALOG_VIEWER']
const APPROVE_ROLES = ['BIME_ADMIN', 'BIME_TRANSFER_APPROVER']
const RECALL_ROLES = ['BIME_ADMIN']
const SELL_ROLES = ['BIME_ADMIN', 'BIME_STOCK_OPERATOR', 'BIME_CASHIER']

function badRequest(message: string): never {
  throw new ApiError(400, 'Bad Request', message)
}

function conflict(message: string): never {
  throw new ApiError(409, 'Conflict', message)
}

function optionCode(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase() || 'OPT'
}

// ── Exchange-rate helpers ──

function rateFor(from: string, to: string): number | null {
  if (from === to) return 1
  const db = getDb()
  const direct = db.exchangeRates.find(r => r.fromCurrency === from && r.toCurrency === to)
  if (direct) return direct.rate
  const inverse = db.exchangeRates.find(r => r.fromCurrency === to && r.toCurrency === from)
  if (inverse) return 1 / inverse.rate
  return null
}

function convertAmount(amount: number, from: string, to: string): number {
  const rate = rateFor(from, to)
  if (rate == null) return amount
  return Math.round(amount * rate * 100) / 100
}

// ── Unit-of-measure conversions ──

function conversionsFor(variantId: string): UomConversionResponse[] {
  return getDb().uomConversions.filter(c => c.variantId === variantId)
}

function effectivePrice(variantPrice: number | null | undefined, factor: number, override: number | null): number | null {
  if (override != null) return override
  if (variantPrice == null) return null
  return Math.round(variantPrice * factor * 100) / 100
}

function hydrateConversion(row: UomConversionResponse): UomConversionResponse {
  const variant = getDb().variants.find(v => v.id === row.variantId)
  return { ...row, effectivePrice: effectivePrice(variant?.price ?? null, row.factor, row.price) }
}

// ── Variants ──

function variantOptionIds(v: ProductVariantResponse): string[] {
  return v.options.map(o => o.id)
}

function matchOptionFilter(optionIds: string[], selected: string[] | undefined, matchAll: boolean | undefined): boolean {
  if (!selected || selected.length === 0) return true
  return matchAll
    ? selected.every(id => optionIds.includes(id))
    : selected.some(id => optionIds.includes(id))
}

function stockFor(variantId: string): { locationId: string; quantity: number; modifiedAt: string }[] {
  return getDb().stockBalances
    .filter(b => b.variantId === variantId)
    .map(b => ({ locationId: b.locationId, quantity: b.quantity, modifiedAt: b.modifiedAt }))
}

function hydrateVariant(v: ProductVariantResponse, currency?: string): ProductVariantResponse {
  const db = getDb()
  const conversions = db.uomConversions.filter(c => c.variantId === v.id).map(hydrateConversion)
  const barcodes = db.barcodes.filter(b => b.variantId === v.id)
  let price = v.price ?? null
  let priceCurrency = v.priceCurrency ?? null
  if (currency && price != null && priceCurrency && currency !== priceCurrency) {
    price = convertAmount(price, priceCurrency, currency)
    priceCurrency = currency
  }
  return {
    ...v,
    price,
    priceCurrency,
    cost: v.cost ?? null,
    costCurrency: v.costCurrency ?? null,
    baseUom: v.baseUom ?? 'units',
    uomConversions: conversions,
    barcodes,
    stock: stockFor(v.id),
  }
}

function genVariantSku(product: ProductResponse, options: MetadataOptionResponse[]): string {
  const parts = options.map(o => o.code || optionCode(o.value))
  const suffix = parts.length ? parts.join('-') : String(getDb().variants.filter(v => v.productId === product.id).length + 1)
  return `${product.sku}-${suffix}`.toUpperCase()
}

function productWithVariants(orgId: string, productId: string): ProductResponse {
  const db = getDb()
  const product = db.products.find(p => p.id === productId && p.orgId === orgId)
  if (!product) notFound()
  const variants = db.variants.filter(v => v.productId === productId)
  const metadataIds = new Set(variants.flatMap(v => v.options.map(o => o.metadataId)))
  const metadata = db.metadata
    .filter(m => metadataIds.has(m.id))
    .map(m => ({
      metadataId: m.id,
      metadataName: m.name,
      selectedOptions: variants.flatMap(v => v.options.filter(o => o.metadataId === m.id)),
    }))
  return {
    ...product,
    tracksBatches: product.tracksBatches ?? false,
    metadata,
    variants: variants.map(v => hydrateVariant(v)),
    variantCount: null,
  }
}

// ── Batches ──

function batchToResponse(rec: BatchRecord): BatchResponse {
  const db = getDb()
  const balances = rec.balances
    .filter(b => b.quantity !== 0)
    .map(b => ({
      locationId: b.locationId,
      locationName: db.locations.find(l => l.id === b.locationId)?.name ?? b.locationId,
      quantity: b.quantity,
    }))
  return {
    id: rec.id,
    variantId: rec.variantId,
    batchCode: rec.batchCode,
    expiryDate: rec.expiryDate,
    status: rec.status,
    recalledAt: rec.recalledAt,
    recallNote: rec.recallNote,
    createdAt: rec.createdAt,
    balances,
    totalQuantity: balances.reduce((n, b) => n + b.quantity, 0),
  }
}

function batchBalanceCell(rec: BatchRecord, locationId: string): { locationId: string; quantity: number } {
  let cell = rec.balances.find(b => b.locationId === locationId)
  if (!cell) {
    cell = { locationId, quantity: 0 }
    rec.balances.push(cell)
  }
  return cell
}

// Parenthesised or bare GS1 element-string parsing, enough for GTIN (01), expiry (17), lot (10).
function parseGs1(raw: string): { gtin?: string; expiry?: string; lot?: string } {
  const out: { gtin?: string; expiry?: string; lot?: string } = {}
  const paren = raw.match(/\((\d{2,4})\)([^(]*)/g)
  if (paren) {
    for (const seg of paren) {
      const m = seg.match(/\((\d{2,4})\)(.*)/)
      if (!m) continue
      const [, ai, val] = m
      if (ai === '01') out.gtin = val.replace(/\D/g, '').slice(-13)
      else if (ai === '17' && val.length >= 6) out.expiry = yymmdd(val.slice(0, 6))
      else if (ai === '10') out.lot = val.trim()
    }
    return out
  }
  // Bare: 01<14>17<6>10<lot...>
  const g = raw.match(/01(\d{14})/)
  if (g) out.gtin = g[1].slice(-13)
  const e = raw.match(/17(\d{6})/)
  if (e) out.expiry = yymmdd(e[1])
  const l = raw.match(/10([^\x1d]+)$/)
  if (l) out.lot = l[1].trim()
  return out
}

function yymmdd(s: string): string {
  const yy = Number(s.slice(0, 2))
  const year = 2000 + yy
  const mm = s.slice(2, 4)
  const dd = s.slice(4, 6) === '00' ? '01' : s.slice(4, 6)
  return `${year}-${mm}-${dd}`
}

// ── Movement application ──

function adjustBalance(db: Db, orgId: string, variantId: string, locationId: string, signedDelta: number): void {
  let balance = db.stockBalances.find(b => b.variantId === variantId && b.locationId === locationId)
  if (!balance) {
    balance = { orgId, variantId, locationId, quantity: 0, modifiedAt: nowIso() }
    db.stockBalances.push(balance)
  }
  balance.quantity += signedDelta
  balance.modifiedAt = nowIso()
}

const OUTFLOW_TYPES: MovementType[] = ['OUTBOUND', 'TRANSFER_OUT', 'SALE']

function isOutflow(type: MovementType, delta: number): boolean {
  if (OUTFLOW_TYPES.includes(type)) return true
  return type === 'ADJUSTMENT' && delta < 0
}

// ── Transfers ──

function transferLineDefaults(): Pick<StockTransferLineResponse, 'qtyDispatched' | 'qtyReceived' | 'qtyInTransit' | 'batches'> {
  return { qtyDispatched: 0, qtyReceived: 0, qtyInTransit: 0, batches: [] }
}

export const bime = {
  roles: async (token: string): Promise<RoleResponse[]> => {
    await delay()
    requireClaims(token)
    return BIME_ROLES
  },

  locations: {
    create: async (dto: LocationRequest, token: string): Promise<LocationResponse> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const row: LocationResponse = {
        id: uid(), orgId: claims.orgId, name: dto.name, code: dto.code, isActive: dto.isActive ?? true,
        notificationEmail: dto.notificationEmail ?? null, notificationEmailVerified: dto.notificationEmail ? true : null,
        createdAt: nowIso(), modifiedAt: nowIso(),
      }
      getDb().locations.push(row)
      persist()
      return row
    },
    list: async (token: string): Promise<LocationResponse[]> => {
      await delay()
      const claims = requireRole(token, ...VIEW_ROLES)
      return getDb().locations.filter(l => l.orgId === claims.orgId)
    },
    get: async (id: string, token: string): Promise<LocationResponse> => {
      await delay()
      const claims = requireRole(token, ...VIEW_ROLES)
      const row = getDb().locations.find(l => l.id === id && l.orgId === claims.orgId)
      if (!row) notFound()
      return row
    },
    update: async (id: string, dto: LocationRequest, token: string): Promise<LocationResponse> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const row = getDb().locations.find(l => l.id === id && l.orgId === claims.orgId)
      if (!row) notFound()
      row.name = dto.name
      row.code = dto.code
      row.isActive = dto.isActive ?? row.isActive
      row.notificationEmail = dto.notificationEmail ?? row.notificationEmail
      row.modifiedAt = nowIso()
      persist()
      return row
    },
    deactivate: async (id: string, token: string): Promise<void> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const row = getDb().locations.find(l => l.id === id && l.orgId === claims.orgId)
      if (!row) notFound()
      row.isActive = false
      row.modifiedAt = nowIso()
      persist()
    },
    confirmNotificationEmail: async (_dto: NotificationEmailVerifyRequest): Promise<void> => { await delay() },
  },

  metadata: {
    create: async (dto: ProductMetadataRequest, token: string): Promise<ProductMetadataResponse> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const row: ProductMetadataResponse = { id: uid(), orgId: claims.orgId, name: dto.name, options: [], createdAt: nowIso() }
      getDb().metadata.push(row)
      persist()
      return row
    },
    list: async (token: string): Promise<ProductMetadataResponse[]> => {
      await delay()
      const claims = requireRole(token, ...CATALOG_ROLES)
      return getDb().metadata.filter(m => m.orgId === claims.orgId)
    },
    get: async (id: string, token: string): Promise<ProductMetadataResponse> => {
      await delay()
      const claims = requireRole(token, ...CATALOG_ROLES)
      const row = getDb().metadata.find(m => m.id === id && m.orgId === claims.orgId)
      if (!row) notFound()
      return row
    },
    delete: async (id: string, token: string): Promise<void> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const db = getDb()
      const idx = db.metadata.findIndex(m => m.id === id && m.orgId === claims.orgId)
      if (idx === -1) notFound()
      db.metadata.splice(idx, 1)
      persist()
    },
    addOption: async (id: string, dto: MetadataOptionRequest, token: string): Promise<MetadataOptionResponse> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const meta = getDb().metadata.find(m => m.id === id && m.orgId === claims.orgId)
      if (!meta) notFound()
      const option: MetadataOptionResponse = {
        id: uid(), metadataId: id, value: dto.value, code: dto.code?.trim() || optionCode(dto.value), createdAt: nowIso(),
      }
      meta.options.push(option)
      persist()
      return option
    },
    removeOption: async (id: string, optionId: string, token: string): Promise<void> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const meta = getDb().metadata.find(m => m.id === id && m.orgId === claims.orgId)
      if (!meta) notFound()
      meta.options = meta.options.filter(o => o.id !== optionId)
      persist()
    },
  },

  products: {
    create: async (dto: ProductRequest, token: string): Promise<ProductResponse> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const row: ProductResponse = {
        id: uid(), orgId: claims.orgId, sku: dto.sku, name: dto.name, description: dto.description ?? null,
        isActive: dto.isActive ?? true, tracksBatches: dto.tracksBatches ?? false,
        createdAt: nowIso(), modifiedAt: nowIso(), metadata: null, variants: null, variantCount: 0,
      }
      getDb().products.push(row)
      persist()
      return row
    },
    list: async (token: string, optionIds?: string[], matchAll?: boolean): Promise<ProductResponse[]> => {
      await delay()
      const claims = requireRole(token, ...CATALOG_ROLES)
      const db = getDb()
      return db.products
        .filter(p => p.orgId === claims.orgId)
        .filter(p => {
          if (!optionIds || optionIds.length === 0) return true
          const variants = db.variants.filter(v => v.productId === p.id)
          return variants.some(v => matchOptionFilter(variantOptionIds(v), optionIds, matchAll))
        })
        .map(p => ({
          ...p,
          tracksBatches: p.tracksBatches ?? false,
          metadata: null,
          variants: null,
          variantCount: db.variants.filter(v => v.productId === p.id).length,
        }))
    },
    get: async (id: string, token: string): Promise<ProductResponse> => {
      await delay()
      const claims = requireRole(token, ...CATALOG_ROLES)
      return productWithVariants(claims.orgId, id)
    },
    update: async (id: string, dto: ProductRequest, token: string): Promise<ProductResponse> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const row = getDb().products.find(p => p.id === id && p.orgId === claims.orgId)
      if (!row) notFound()
      row.sku = dto.sku
      row.name = dto.name
      row.description = dto.description ?? row.description
      row.isActive = dto.isActive ?? row.isActive
      if (dto.tracksBatches !== undefined) row.tracksBatches = dto.tracksBatches
      row.modifiedAt = nowIso()
      persist()
      return row
    },
    deactivate: async (id: string, token: string): Promise<void> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const row = getDb().products.find(p => p.id === id && p.orgId === claims.orgId)
      if (!row) notFound()
      row.isActive = false
      row.modifiedAt = nowIso()
      persist()
    },
    assignMetadata: async (id: string, assignments: ProductMetadataAssignmentItem[], token: string): Promise<void> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const db = getDb()
      const variants = db.variants.filter(v => v.productId === id)
      if (!db.products.some(p => p.id === id && p.orgId === claims.orgId)) notFound()
      const selectedOptions = assignments.flatMap(a => {
        const meta = db.metadata.find(m => m.id === a.metadataId)
        return meta ? meta.options.filter(o => a.optionIds.includes(o.id)) : []
      })
      variants.forEach(v => { v.options = selectedOptions })
      persist()
    },
    patchMetadataOptions: async (id: string, metadataId: string, dto: MetadataOptionPatch, token: string): Promise<void> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const db = getDb()
      const meta = db.metadata.find(m => m.id === metadataId && m.orgId === claims.orgId)
      if (!meta || !db.products.some(p => p.id === id)) notFound()
      dto.add.forEach(value => meta.options.push({ id: uid(), metadataId, value, code: optionCode(value), createdAt: nowIso() }))
      meta.options = meta.options.filter(o => !dto.remove.includes(o.id))
      persist()
    },
  },

  variants: {
    create: async (productId: string, dto: ProductVariantRequest, token: string): Promise<ProductVariantResponse> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const db = getDb()
      const product = db.products.find(p => p.id === productId && p.orgId === claims.orgId)
      if (!product) notFound()
      const options = db.metadata.flatMap(m => m.options).filter(o => dto.optionIds.includes(o.id))
      const variantId = uid()
      const row: ProductVariantResponse = {
        id: variantId, productId, orgId: claims.orgId,
        sku: genVariantSku(product, options),
        isActive: dto.isActive ?? true,
        createdAt: nowIso(), options, stock: [],
        price: dto.price ?? null, priceCurrency: dto.priceCurrency ?? null,
        cost: dto.cost ?? null, costCurrency: dto.costCurrency ?? null,
        baseUom: dto.baseUom || 'units',
        uomConversions: [], barcodes: [],
      }
      db.variants.push(row)
      for (const c of dto.uomConversions ?? []) {
        db.uomConversions.push({
          id: uid(), orgId: claims.orgId, variantId, uomName: c.uomName, factor: c.factor,
          price: c.price ?? null, effectivePrice: effectivePrice(row.price, c.factor, c.price ?? null),
          createdAt: nowIso(), modifiedAt: nowIso(),
        })
      }
      persist()
      return hydrateVariant(row)
    },
    list: async (
      productId: string, token: string, currency?: string, optionIds?: string[], matchAll?: boolean, sku?: string,
    ): Promise<ProductVariantResponse[]> => {
      await delay()
      const claims = requireRole(token, ...VIEW_ROLES)
      const skuQ = sku?.trim().toLowerCase()
      return getDb().variants
        .filter(v => v.productId === productId && v.orgId === claims.orgId)
        .filter(v => matchOptionFilter(variantOptionIds(v), optionIds, matchAll))
        .filter(v => !skuQ || (v.sku ?? '').toLowerCase().includes(skuQ))
        .map(v => hydrateVariant(v, currency))
    },
    search: async (
      optionIds: string[] | undefined, token: string, currency?: string, matchAll?: boolean, sku?: string,
    ): Promise<ProductVariantResponse[]> => {
      await delay()
      const claims = requireRole(token, ...VIEW_ROLES)
      const skuQ = sku?.trim().toLowerCase()
      return getDb().variants
        .filter(v => v.orgId === claims.orgId)
        .filter(v => matchOptionFilter(variantOptionIds(v), optionIds, matchAll))
        .filter(v => !skuQ || (v.sku ?? '').toLowerCase().includes(skuQ))
        .map(v => hydrateVariant(v, currency))
    },
    get: async (productId: string, variantId: string, token: string, currency?: string): Promise<ProductVariantResponse> => {
      await delay()
      const claims = requireRole(token, ...VIEW_ROLES)
      const row = getDb().variants.find(v => v.id === variantId && v.productId === productId && v.orgId === claims.orgId)
      if (!row) notFound()
      return hydrateVariant(row, currency)
    },
    patch: async (productId: string, variantId: string, dto: ProductVariantRequest, token: string): Promise<ProductVariantResponse> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const db = getDb()
      const row = db.variants.find(v => v.id === variantId && v.productId === productId && v.orgId === claims.orgId)
      if (!row) notFound()
      if (dto.optionIds && dto.optionIds.length) row.options = db.metadata.flatMap(m => m.options).filter(o => dto.optionIds.includes(o.id))
      if (dto.isActive !== undefined) row.isActive = dto.isActive
      if (dto.price !== undefined) row.price = dto.price
      if (dto.priceCurrency !== undefined) row.priceCurrency = dto.priceCurrency
      if (dto.cost !== undefined) row.cost = dto.cost
      if (dto.costCurrency !== undefined) row.costCurrency = dto.costCurrency
      if (dto.baseUom) row.baseUom = dto.baseUom
      persist()
      return hydrateVariant(row)
    },
    deactivate: async (productId: string, variantId: string, token: string): Promise<void> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const row = getDb().variants.find(v => v.id === variantId && v.productId === productId && v.orgId === claims.orgId)
      if (!row) notFound()
      row.isActive = false
      persist()
    },
    batchUpdatePrices: async (dto: VariantBatchPriceRequest, token: string): Promise<string[]> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const db = getDb()
      const updated: string[] = []
      for (const item of dto.items) {
        const variant = db.variants.find(v => v.id === item.variantId && v.orgId === claims.orgId)
        if (variant) { variant.price = item.price; updated.push(variant.id) }
      }
      persist()
      return updated
    },
    batchUpdateCosts: async (dto: VariantBatchCostRequest, token: string): Promise<string[]> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const db = getDb()
      const updated: string[] = []
      for (const item of dto.items) {
        const variant = db.variants.find(v => v.id === item.variantId && v.orgId === claims.orgId)
        if (variant) { variant.cost = item.cost; updated.push(variant.id) }
      }
      persist()
      return updated
    },
  },

  units: {
    list: async (token: string): Promise<OrgUnitResponse[]> => {
      await delay()
      const claims = requireRole(token, ...CATALOG_ROLES)
      return getDb().units.filter(u => u.orgId === claims.orgId)
    },
    create: async (dto: OrgUnitRequest, token: string): Promise<OrgUnitResponse> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const db = getDb()
      const name = dto.name.trim()
      if (!name) badRequest('Unit name is required.')
      if (db.units.some(u => u.orgId === claims.orgId && u.name.toLowerCase() === name.toLowerCase())) {
        conflict(`Unit "${name}" already exists.`)
      }
      const row: OrgUnitResponse = { id: uid(), orgId: claims.orgId, name, standard: false, createdAt: nowIso() }
      db.units.push(row)
      persist()
      return row
    },
    delete: async (id: string, token: string): Promise<void> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const db = getDb()
      const unit = db.units.find(u => u.id === id && u.orgId === claims.orgId)
      if (!unit) notFound()
      if (unit.standard) badRequest('Standard units cannot be removed.')
      if (db.uomConversions.some(c => c.orgId === claims.orgId && c.uomName === unit.name)) {
        conflict('This unit is still used by a variant conversion.')
      }
      db.units = db.units.filter(u => u.id !== id)
      persist()
    },
  },

  uomConversions: {
    set: async (variantId: string, dto: UomConversionRequest, token: string): Promise<UomConversionResponse> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const db = getDb()
      const variant = db.variants.find(v => v.id === variantId && v.orgId === claims.orgId)
      if (!variant) notFound()
      if (dto.factor <= 0) badRequest('Conversion factor must be greater than zero.')
      let row = db.uomConversions.find(c => c.variantId === variantId && c.uomName === dto.uomName)
      if (row) {
        row.factor = dto.factor
        row.price = dto.price ?? null
        row.modifiedAt = nowIso()
      } else {
        row = {
          id: uid(), orgId: claims.orgId, variantId, uomName: dto.uomName, factor: dto.factor,
          price: dto.price ?? null, effectivePrice: null, createdAt: nowIso(), modifiedAt: nowIso(),
        }
        db.uomConversions.push(row)
      }
      persist()
      return hydrateConversion(row)
    },
    list: async (variantId: string, token: string): Promise<UomConversionResponse[]> => {
      await delay()
      requireRole(token, ...VIEW_ROLES)
      return conversionsFor(variantId).map(hydrateConversion)
    },
    delete: async (variantId: string, uomName: string, token: string): Promise<void> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const db = getDb()
      db.uomConversions = db.uomConversions.filter(c => !(c.variantId === variantId && c.uomName === uomName && c.orgId === claims.orgId))
      persist()
    },
  },

  barcodes: {
    list: async (_productId: string, variantId: string, token: string): Promise<VariantBarcodeResponse[]> => {
      await delay()
      requireRole(token, ...VIEW_ROLES)
      return getDb().barcodes.filter(b => b.variantId === variantId)
    },
    link: async (productId: string, variantId: string, dto: VariantBarcodeRequest, token: string): Promise<VariantBarcodeResponse> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const db = getDb()
      const variant = db.variants.find(v => v.id === variantId && v.productId === productId && v.orgId === claims.orgId)
      if (!variant) notFound()
      if (db.barcodes.some(b => b.barcode === dto.barcode)) conflict(`Barcode ${dto.barcode} is already linked.`)
      const uom = dto.uom || variant.baseUom
      const conv = db.uomConversions.find(c => c.variantId === variantId && c.uomName === uom)
      const row: VariantBarcodeResponse = {
        id: uid(), orgId: claims.orgId, variantId, barcode: dto.barcode, symbology: dto.symbology,
        source: 'PROVIDER', uom, factor: uom === variant.baseUom ? 1 : (conv?.factor ?? null),
        isPrimary: dto.isPrimary ?? db.barcodes.filter(b => b.variantId === variantId).length === 0,
        createdAt: nowIso(),
      }
      if (row.isPrimary) db.barcodes.forEach(b => { if (b.variantId === variantId) b.isPrimary = false })
      db.barcodes.push(row)
      variant.barcodes = db.barcodes.filter(b => b.variantId === variantId)
      persist()
      return row
    },
    issue: async (productId: string, variantId: string, dto: VariantBarcodeIssueRequest, token: string): Promise<VariantBarcodeResponse> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const db = getDb()
      const variant = db.variants.find(v => v.id === variantId && v.productId === productId && v.orgId === claims.orgId)
      if (!variant) notFound()
      let settings = db.orgBarcodeSettings.find(s => s.orgId === claims.orgId)
      if (!settings) {
        settings = { orgId: claims.orgId, gs1Prefix: null, nextSequence: 1, createdAt: nowIso(), modifiedAt: nowIso() }
        db.orgBarcodeSettings.push(settings)
      }
      const prefix = settings.gs1Prefix ?? '0200000'
      const body = (prefix + String(settings.nextSequence).padStart(12 - prefix.length, '0')).slice(0, 12)
      let sum = 0
      for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3)
      const barcode = body + String((10 - (sum % 10)) % 10)
      settings.nextSequence += 1
      settings.modifiedAt = nowIso()
      const uom = dto.uom || variant.baseUom
      const conv = db.uomConversions.find(c => c.variantId === variantId && c.uomName === uom)
      const row: VariantBarcodeResponse = {
        id: uid(), orgId: claims.orgId, variantId, barcode, symbology: 'EAN13',
        source: 'ISSUED', uom, factor: uom === variant.baseUom ? 1 : (conv?.factor ?? null),
        isPrimary: dto.isPrimary ?? db.barcodes.filter(b => b.variantId === variantId).length === 0,
        createdAt: nowIso(),
      }
      if (row.isPrimary) db.barcodes.forEach(b => { if (b.variantId === variantId) b.isPrimary = false })
      db.barcodes.push(row)
      variant.barcodes = db.barcodes.filter(b => b.variantId === variantId)
      persist()
      return row
    },
    setPrimary: async (_productId: string, variantId: string, barcode: string, dto: VariantBarcodePrimaryRequest, token: string): Promise<VariantBarcodeResponse> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const db = getDb()
      const row = db.barcodes.find(b => b.variantId === variantId && b.barcode === barcode && b.orgId === claims.orgId)
      if (!row) notFound()
      if (dto.isPrimary) db.barcodes.forEach(b => { if (b.variantId === variantId) b.isPrimary = false })
      row.isPrimary = dto.isPrimary
      persist()
      return row
    },
    remove: async (_productId: string, variantId: string, barcode: string, token: string): Promise<void> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const db = getDb()
      db.barcodes = db.barcodes.filter(b => !(b.variantId === variantId && b.barcode === barcode && b.orgId === claims.orgId))
      const variant = db.variants.find(v => v.id === variantId)
      if (variant) variant.barcodes = db.barcodes.filter(b => b.variantId === variantId)
      persist()
    },
    lookup: async (barcode: string, token: string): Promise<BarcodeLookupResponse> => {
      await delay()
      const claims = requireRole(token, ...CATALOG_ROLES)
      const db = getDb()
      const raw = barcode.trim()
      const gs1 = parseGs1(raw)
      const plain = raw.replace(/[()\s\x1d]/g, '')
      let row = db.barcodes.find(b => b.orgId === claims.orgId && (b.barcode === raw || b.barcode === plain))
      if (!row && gs1.gtin) row = db.barcodes.find(b => b.orgId === claims.orgId && b.barcode === gs1.gtin)
      if (!row) notFound()
      const variant = db.variants.find(v => v.id === row!.variantId)
      if (!variant) notFound()
      const product = db.products.find(p => p.id === variant.productId)!
      const hydrated = hydrateVariant(variant)
      const factor = row.factor
      const packPrice = factor != null && factor !== 1
        ? (db.uomConversions.find(c => c.variantId === variant.id && c.uomName === row!.uom)?.price
            ?? (variant.price != null ? Math.round(variant.price * factor * 100) / 100 : null))
        : (variant.price ?? null)

      let batchCode: string | null = null
      let batchExpiry: string | null = null
      let batchStatus: string | null = null
      let recalled = false
      let expired = false
      if (gs1.lot) {
        batchCode = gs1.lot
        const lot = db.batches.find(b => b.variantId === variant.id && b.batchCode === gs1.lot)
        if (lot) {
          batchExpiry = lot.expiryDate
          batchStatus = lot.status
          recalled = lot.status === 'RECALLED'
          expired = !!lot.expiryDate && new Date(lot.expiryDate).getTime() < Date.now()
        } else {
          batchStatus = 'UNKNOWN'
        }
      } else if (gs1.expiry) {
        batchExpiry = gs1.expiry
        expired = new Date(gs1.expiry).getTime() < Date.now()
      }

      return {
        barcode: row.barcode,
        symbology: row.symbology,
        productId: product.id,
        productSku: product.sku,
        productName: product.name,
        uom: row.uom,
        factor,
        packPrice,
        variant: hydrated,
        batchCode,
        batchExpiry,
        batchStatus,
        expired,
        recalled,
      }
    },
    getSettings: async (token: string): Promise<OrgBarcodeSettingsResponse> => {
      await delay()
      const claims = requireRole(token, ...CATALOG_ROLES)
      const db = getDb()
      const existing = db.orgBarcodeSettings.find(s => s.orgId === claims.orgId)
      if (existing) return existing
      return { orgId: claims.orgId, gs1Prefix: null, nextSequence: 1, createdAt: null, modifiedAt: null }
    },
    updateSettings: async (dto: OrgBarcodeSettingsRequest, token: string): Promise<OrgBarcodeSettingsResponse> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const db = getDb()
      let row = db.orgBarcodeSettings.find(s => s.orgId === claims.orgId)
      const prefix = dto.gs1Prefix?.trim() || null
      if (prefix && !/^\d{4,11}$/.test(prefix)) badRequest('GS1 prefix must be 4–11 digits.')
      if (!row) {
        row = { orgId: claims.orgId, gs1Prefix: prefix, nextSequence: 1, createdAt: nowIso(), modifiedAt: nowIso() }
        db.orgBarcodeSettings.push(row)
      } else {
        row.gs1Prefix = prefix
        row.modifiedAt = nowIso()
      }
      persist()
      return row
    },
    labelsPdf: async (productId: string, _opts: unknown, token: string): Promise<Blob> => {
      await delay()
      const claims = requireRole(token, ...CATALOG_ROLES)
      const db = getDb()
      const product = db.products.find(p => p.id === productId && p.orgId === claims.orgId)
      if (!product) notFound()
      const lines = [`Kenoma demo — barcode labels`, `Product: ${product.name} (${product.sku})`, '']
      for (const v of db.variants.filter(v => v.productId === productId)) {
        for (const b of db.barcodes.filter(b => b.variantId === v.id)) {
          lines.push(`${v.sku ?? v.id}  ${b.barcode}  ${b.symbology}  ${b.uom}${b.factor && b.factor !== 1 ? ` ×${b.factor}` : ''}${b.isPrimary ? '  (primary)' : ''}`)
        }
      }
      return buildTextPdf(lines)
    },
  },

  batches: {
    list: async (
      token: string,
      filters: { variantId?: string; locationId?: string; status?: BatchStatus; expiringWithinDays?: number } = {},
    ): Promise<BatchResponse[]> => {
      await delay()
      const claims = requireRole(token, ...VIEW_ROLES)
      const db = getDb()
      const cutoff = filters.expiringWithinDays != null
        ? Date.now() + filters.expiringWithinDays * 86_400_000
        : null
      return db.batches
        .filter(b => b.orgId === claims.orgId)
        .filter(b => !filters.variantId || b.variantId === filters.variantId)
        .filter(b => !filters.status || b.status === filters.status)
        .filter(b => !filters.locationId || b.balances.some(x => x.locationId === filters.locationId && x.quantity > 0))
        .filter(b => cutoff == null || (b.expiryDate != null && new Date(b.expiryDate).getTime() <= cutoff))
        .map(batchToResponse)
    },
    get: async (id: string, token: string): Promise<BatchResponse> => {
      await delay()
      const claims = requireRole(token, ...VIEW_ROLES)
      const rec = getDb().batches.find(b => b.id === id && b.orgId === claims.orgId)
      if (!rec) notFound()
      return batchToResponse(rec)
    },
    recallReport: async (id: string, token: string): Promise<RecallReport> => {
      await delay()
      const claims = requireRole(token, ...VIEW_ROLES)
      const db = getDb()
      const rec = db.batches.find(b => b.id === id && b.orgId === claims.orgId)
      if (!rec) notFound()
      const batch = batchToResponse(rec)
      return {
        batch,
        affectedLocations: batch.balances,
        history: db.stockMovements.filter(m => m.orgId === claims.orgId && m.batchId === id),
      }
    },
    recall: async (id: string, dto: RecallRequest, token: string): Promise<BatchResponse> => {
      await delay()
      const claims = requireRole(token, ...RECALL_ROLES)
      const rec = getDb().batches.find(b => b.id === id && b.orgId === claims.orgId)
      if (!rec) notFound()
      rec.status = 'RECALLED'
      rec.recalledAt = nowIso()
      rec.recallNote = dto.note ?? null
      persist()
      return batchToResponse(rec)
    },
    liftRecall: async (id: string, token: string): Promise<BatchResponse> => {
      await delay()
      const claims = requireRole(token, ...RECALL_ROLES)
      const rec = getDb().batches.find(b => b.id === id && b.orgId === claims.orgId)
      if (!rec) notFound()
      rec.status = 'ACTIVE'
      rec.recalledAt = null
      rec.recallNote = null
      persist()
      return batchToResponse(rec)
    },
    getSettings: async (token: string): Promise<OrgBatchSettingsResponse> => {
      await delay()
      const claims = requireRole(token, ...VIEW_ROLES)
      const db = getDb()
      const existing = db.orgBatchSettings.find(s => s.orgId === claims.orgId)
      if (existing) return existing
      return { orgId: claims.orgId, nearExpiryDays: 30, createdAt: null, modifiedAt: null }
    },
    updateSettings: async (dto: OrgBatchSettingsRequest, token: string): Promise<OrgBatchSettingsResponse> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const db = getDb()
      if (dto.nearExpiryDays < 1) badRequest('Near-expiry window must be at least 1 day.')
      let row = db.orgBatchSettings.find(s => s.orgId === claims.orgId)
      if (!row) {
        row = { orgId: claims.orgId, nearExpiryDays: dto.nearExpiryDays, createdAt: nowIso(), modifiedAt: nowIso() }
        db.orgBatchSettings.push(row)
      } else {
        row.nearExpiryDays = dto.nearExpiryDays
        row.modifiedAt = nowIso()
      }
      persist()
      return row
    },
  },

  stock: {
    recordMovement: async (dto: StockMovementRequest, token: string): Promise<StockMovementResponse> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const db = getDb()
      const variant = db.variants.find(v => v.id === dto.variantId && v.orgId === claims.orgId)
      if (!variant) notFound()
      const product = db.products.find(p => p.id === variant.productId)!
      const status = dto.status ?? 'POSTED'

      // Resolve the unit the delta is expressed in.
      let factor = 1
      let uomQuantity: number | null = null
      let uomName: string | null = null
      if (dto.uom && dto.uom !== variant.baseUom) {
        const conv = db.uomConversions.find(c => c.variantId === variant.id && c.uomName === dto.uom)
        if (!conv) badRequest(`Unit "${dto.uom}" is not configured for this variant.`)
        factor = conv.factor
        uomName = dto.uom
        uomQuantity = dto.delta
      }
      const baseDelta = Math.round(dto.delta * factor * 1000) / 1000
      const signed = isOutflow(dto.movementType, baseDelta) ? -Math.abs(baseDelta) : Math.abs(baseDelta)

      const movement: StockMovementResponse = {
        id: uid(), orgId: claims.orgId, productId: variant.productId, variantId: dto.variantId, locationId: dto.locationId,
        movementType: dto.movementType, status, delta: signed, uom: uomName, uomQuantity,
        referenceId: dto.referenceId ?? null, note: dto.note ?? null,
        createdAt: nowIso(), createdBy: claims.sub, batchId: null, allocations: null,
      }

      if (status !== 'POSTED') {
        db.stockMovements.push(movement)
        persist()
        return movement
      }

      const tracksBatches = product.tracksBatches ?? false
      if (tracksBatches && signed > 0) {
        // Inbound to a lot: name it from an explicit batch, a code+expiry, or a raw GS1 scan.
        const gs1 = dto.gs1 ? parseGs1(dto.gs1) : null
        const code = dto.batchCode ?? gs1?.lot
        const expiry = dto.expiryDate ?? gs1?.expiry ?? null
        let rec = dto.batchId
          ? db.batches.find(b => b.id === dto.batchId && b.orgId === claims.orgId)
          : code
            ? db.batches.find(b => b.orgId === claims.orgId && b.variantId === variant.id && b.batchCode === code)
            : undefined
        if (!rec) {
          if (!code) badRequest('A batch code (or GS1 scan) is required for a batch-tracked inbound.')
          rec = {
            id: uid(), orgId: claims.orgId, variantId: variant.id, batchCode: code,
            expiryDate: expiry, status: 'ACTIVE', recalledAt: null, recallNote: null, createdAt: nowIso(), balances: [],
          }
          db.batches.push(rec)
        }
        batchBalanceCell(rec, dto.locationId).quantity += signed
        movement.batchId = rec.id
      } else if (tracksBatches && signed < 0) {
        // Outbound: draw from a chosen lot, or FEFO across active lots at this location.
        const need = Math.abs(signed)
        const candidates = dto.batchId
          ? db.batches.filter(b => b.id === dto.batchId)
          : db.batches
              .filter(b => b.orgId === claims.orgId && b.variantId === variant.id && b.status === 'ACTIVE')
              .filter(b => (b.balances.find(x => x.locationId === dto.locationId)?.quantity ?? 0) > 0)
              .sort((a, b) => {
                if (!a.expiryDate) return 1
                if (!b.expiryDate) return -1
                return a.expiryDate.localeCompare(b.expiryDate)
              })
        let remaining = need
        const allocations: StockMovementResponse[] = []
        for (const rec of candidates) {
          if (remaining <= 0) break
          const cell = rec.balances.find(x => x.locationId === dto.locationId)
          const take = Math.min(remaining, cell?.quantity ?? 0)
          if (take <= 0) continue
          cell!.quantity -= take
          remaining -= take
          allocations.push({
            ...movement, id: uid(), delta: -take, uom: null, uomQuantity: null, batchId: rec.id, allocations: null,
          })
        }
        if (remaining > 0) conflict('Not enough batch-tracked stock at this location.')
        movement.batchId = allocations.length === 1 ? allocations[0].batchId : null
        movement.allocations = allocations.length > 1 ? allocations : null
        db.stockMovements.push(...allocations)
      }

      db.stockMovements.push(movement)
      adjustBalance(db, claims.orgId, dto.variantId, dto.locationId, signed)
      persist()
      return movement
    },
    getMovement: async (id: string, token: string): Promise<StockMovementResponse> => {
      await delay()
      const claims = requireRole(token, ...VIEW_ROLES)
      const row = getDb().stockMovements.find(m => m.id === id && m.orgId === claims.orgId)
      if (!row) notFound()
      return row
    },
    listMovements: async (
      token: string,
      filters: { variantId?: string; locationId?: string; optionIds?: string[]; matchAll?: boolean } = {},
    ): Promise<StockMovementResponse[]> => {
      await delay()
      const claims = requireRole(token, ...VIEW_ROLES)
      const db = getDb()
      const allowed = filters.optionIds && filters.optionIds.length
        ? new Set(db.variants.filter(v => matchOptionFilter(variantOptionIds(v), filters.optionIds, filters.matchAll)).map(v => v.id))
        : null
      return db.stockMovements.filter(m =>
        m.orgId === claims.orgId
        && (!filters.variantId || m.variantId === filters.variantId)
        && (!filters.locationId || m.locationId === filters.locationId)
        && (!allowed || allowed.has(m.variantId)))
    },
    listBalances: async (
      token: string,
      filters: { variantId?: string; locationId?: string; optionIds?: string[]; matchAll?: boolean } = {},
    ): Promise<StockBalanceResponse[]> => {
      await delay()
      const claims = requireRole(token, ...VIEW_ROLES)
      const db = getDb()
      const allowed = filters.optionIds && filters.optionIds.length
        ? new Set(db.variants.filter(v => matchOptionFilter(variantOptionIds(v), filters.optionIds, filters.matchAll)).map(v => v.id))
        : null
      return db.stockBalances.filter(b =>
        b.orgId === claims.orgId
        && (!filters.variantId || b.variantId === filters.variantId)
        && (!filters.locationId || b.locationId === filters.locationId)
        && (!allowed || allowed.has(b.variantId)))
    },
    setAlertThreshold: async (dto: StockAlertThresholdRequest, token: string): Promise<StockAlertThresholdResponse> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const db = getDb()
      let row = db.alertThresholds.find(t => t.variantId === dto.variantId && t.locationId === dto.locationId && t.orgId === claims.orgId)
      if (!row) {
        row = { orgId: claims.orgId, variantId: dto.variantId, locationId: dto.locationId, threshold: dto.threshold, createdAt: nowIso(), modifiedAt: nowIso() }
        db.alertThresholds.push(row)
      } else {
        row.threshold = dto.threshold
        row.modifiedAt = nowIso()
      }
      persist()
      return row
    },
    listAlertThresholds: async (
      token: string,
      filters: { variantId?: string; locationId?: string; optionIds?: string[]; matchAll?: boolean } = {},
    ): Promise<StockAlertThresholdResponse[]> => {
      await delay()
      const claims = requireRole(token, ...VIEW_ROLES)
      const db = getDb()
      const allowed = filters.optionIds && filters.optionIds.length
        ? new Set(db.variants.filter(v => matchOptionFilter(variantOptionIds(v), filters.optionIds, filters.matchAll)).map(v => v.id))
        : null
      return db.alertThresholds.filter(t =>
        t.orgId === claims.orgId
        && (!filters.variantId || t.variantId === filters.variantId)
        && (!filters.locationId || t.locationId === filters.locationId)
        && (!allowed || allowed.has(t.variantId)))
    },
    deleteAlertThreshold: async (variantId: string, locationId: string, token: string): Promise<void> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const db = getDb()
      db.alertThresholds = db.alertThresholds.filter(t => !(t.variantId === variantId && t.locationId === locationId && t.orgId === claims.orgId))
      persist()
    },
    listActiveAlerts: async (
      token: string,
      filters: { variantId?: string; locationId?: string; optionIds?: string[]; matchAll?: boolean } = {},
    ): Promise<StockAlertResponse[]> => {
      await delay()
      const claims = requireRole(token, ...VIEW_ROLES)
      const db = getDb()
      const allowed = filters.optionIds && filters.optionIds.length
        ? new Set(db.variants.filter(v => matchOptionFilter(variantOptionIds(v), filters.optionIds, filters.matchAll)).map(v => v.id))
        : null
      return db.alertThresholds
        .filter(t => t.orgId === claims.orgId
          && (!filters.variantId || t.variantId === filters.variantId)
          && (!filters.locationId || t.locationId === filters.locationId)
          && (!allowed || allowed.has(t.variantId)))
        .map(t => {
          const balance = db.stockBalances.find(b => b.variantId === t.variantId && b.locationId === t.locationId)
          return balance && balance.quantity <= t.threshold
            ? { orgId: t.orgId, variantId: t.variantId, locationId: t.locationId, threshold: t.threshold, quantity: balance.quantity, triggeredAt: balance.modifiedAt }
            : null
        })
        .filter((a): a is StockAlertResponse => a !== null)
    },
  },

  transfers: {
    list: async (
      token: string,
      filters: { status?: string; sourceLocationId?: string; destLocationId?: string; variantId?: string } = {},
    ): Promise<StockTransferResponse[]> => {
      await delay()
      const claims = requireRole(token, ...VIEW_ROLES)
      return getDb().transfers
        .filter(tr => tr.orgId === claims.orgId)
        .filter(tr => !filters.status || tr.status === filters.status)
        .filter(tr => !filters.sourceLocationId || tr.sourceLocationId === filters.sourceLocationId)
        .filter(tr => !filters.destLocationId || tr.destLocationId === filters.destLocationId)
        .filter(tr => !filters.variantId || tr.lines.some(l => l.variantId === filters.variantId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    },
    get: async (id: string, token: string): Promise<StockTransferResponse> => {
      await delay()
      const claims = requireRole(token, ...VIEW_ROLES)
      const row = getDb().transfers.find(tr => tr.id === id && tr.orgId === claims.orgId)
      if (!row) notFound()
      return row
    },
    inTransit: async (token: string): Promise<InTransitStock[]> => {
      await delay()
      const claims = requireRole(token, ...VIEW_ROLES)
      const acc = new Map<string, InTransitStock>()
      for (const tr of getDb().transfers.filter(tr => tr.orgId === claims.orgId)) {
        if (!tr.destLocationId) continue
        for (const l of tr.lines) {
          if (l.qtyInTransit <= 0) continue
          const key = `${l.variantId}|${tr.destLocationId}`
          const cur = acc.get(key) ?? { variantId: l.variantId, destLocationId: tr.destLocationId, quantity: 0 }
          cur.quantity += l.qtyInTransit
          acc.set(key, cur)
        }
      }
      return [...acc.values()]
    },
    create: async (dto: StockTransferRequest, token: string): Promise<StockTransferResponse> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const db = getDb()
      if (dto.sourceLocationId === dto.destLocationId) badRequest('Source and destination must differ.')
      const lines: StockTransferLineResponse[] = dto.lines.map(l => {
        const variant = db.variants.find(v => v.id === l.variantId)
        const factor = l.uom && variant
          ? (db.uomConversions.find(c => c.variantId === l.variantId && c.uomName === l.uom)?.factor ?? 1)
          : 1
        return {
          id: uid(), variantId: l.variantId, sourceLocationId: dto.sourceLocationId, destLocationId: dto.destLocationId,
          qtyRequested: Math.round(l.quantity * factor * 1000) / 1000,
          uom: l.uom ?? null, uomQuantity: l.uom ? l.quantity : null,
          ...transferLineDefaults(),
        }
      })
      const row: StockTransferResponse = {
        id: uid(), orgId: claims.orgId, reference: dto.reference ?? null, status: 'DRAFT', note: dto.note ?? null,
        sourceLocationId: dto.sourceLocationId, destLocationId: dto.destLocationId, lines,
        createdAt: nowIso(), createdBy: claims.sub,
        submittedAt: null, submittedBy: null, approvedAt: null, approvedBy: null,
        dispatchedAt: null, dispatchedBy: null, completedAt: null, completedBy: null, cancelledAt: null, cancelledBy: null,
      }
      db.transfers.push(row)
      persist()
      return row
    },
    update: async (id: string, dto: StockTransferRequest, token: string): Promise<StockTransferResponse> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const db = getDb()
      const row = db.transfers.find(tr => tr.id === id && tr.orgId === claims.orgId)
      if (!row) notFound()
      if (row.status !== 'DRAFT') conflict('Only draft transfers can be edited.')
      if (dto.sourceLocationId === dto.destLocationId) badRequest('Source and destination must differ.')
      row.reference = dto.reference ?? null
      row.note = dto.note ?? null
      row.sourceLocationId = dto.sourceLocationId
      row.destLocationId = dto.destLocationId
      row.lines = dto.lines.map(l => {
        const factor = l.uom
          ? (db.uomConversions.find(c => c.variantId === l.variantId && c.uomName === l.uom)?.factor ?? 1)
          : 1
        return {
          id: uid(), variantId: l.variantId, sourceLocationId: dto.sourceLocationId, destLocationId: dto.destLocationId,
          qtyRequested: Math.round(l.quantity * factor * 1000) / 1000,
          uom: l.uom ?? null, uomQuantity: l.uom ? l.quantity : null,
          ...transferLineDefaults(),
        }
      })
      persist()
      return row
    },
    remove: async (id: string, token: string): Promise<void> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const db = getDb()
      const row = db.transfers.find(tr => tr.id === id && tr.orgId === claims.orgId)
      if (!row) notFound()
      if (row.status !== 'DRAFT') conflict('Only draft transfers can be deleted.')
      db.transfers = db.transfers.filter(tr => tr.id !== id)
      persist()
    },
    submit: async (id: string, token: string): Promise<StockTransferResponse> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const row = getDb().transfers.find(tr => tr.id === id && tr.orgId === claims.orgId)
      if (!row) notFound()
      if (row.status !== 'DRAFT') conflict('Transfer is not a draft.')
      row.status = 'PENDING_APPROVAL'
      row.submittedAt = nowIso()
      row.submittedBy = claims.sub
      persist()
      return row
    },
    approve: async (id: string, token: string): Promise<StockTransferResponse> => {
      await delay()
      const claims = requireRole(token, ...APPROVE_ROLES)
      const row = getDb().transfers.find(tr => tr.id === id && tr.orgId === claims.orgId)
      if (!row) notFound()
      if (row.status !== 'PENDING_APPROVAL') conflict('Transfer is not pending approval.')
      row.status = 'APPROVED'
      row.approvedAt = nowIso()
      row.approvedBy = claims.sub
      persist()
      return row
    },
    reject: async (id: string, token: string): Promise<StockTransferResponse> => {
      await delay()
      const claims = requireRole(token, ...APPROVE_ROLES)
      const row = getDb().transfers.find(tr => tr.id === id && tr.orgId === claims.orgId)
      if (!row) notFound()
      if (row.status !== 'PENDING_APPROVAL') conflict('Transfer is not pending approval.')
      row.status = 'DRAFT'
      row.submittedAt = null
      row.submittedBy = null
      persist()
      return row
    },
    dispatch: async (id: string, token: string): Promise<StockTransferResponse> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const db = getDb()
      const row = db.transfers.find(tr => tr.id === id && tr.orgId === claims.orgId)
      if (!row) notFound()
      if (row.status !== 'APPROVED') conflict('Transfer must be approved before dispatch.')
      if (!row.sourceLocationId) badRequest('Transfer has no source location.')
      for (const l of row.lines) {
        const bal = db.stockBalances.find(b => b.variantId === l.variantId && b.locationId === row.sourceLocationId)
        const outstanding = l.qtyRequested - l.qtyDispatched
        if ((bal?.quantity ?? 0) < outstanding) conflict('Not enough stock at the source location to dispatch.')
      }
      for (const l of row.lines) {
        const qty = l.qtyRequested - l.qtyDispatched
        adjustBalance(db, claims.orgId, l.variantId, row.sourceLocationId, -qty)
        db.stockMovements.push({
          id: uid(), orgId: claims.orgId, productId: db.variants.find(v => v.id === l.variantId)?.productId ?? '',
          variantId: l.variantId, locationId: row.sourceLocationId, movementType: 'TRANSFER_OUT', status: 'POSTED',
          delta: -qty, uom: null, uomQuantity: null, referenceId: row.id, note: row.reference ?? null,
          createdAt: nowIso(), createdBy: claims.sub, batchId: null, allocations: null,
        })
        l.qtyDispatched = l.qtyRequested
        l.qtyInTransit = l.qtyDispatched - l.qtyReceived
      }
      row.status = 'IN_TRANSIT'
      row.dispatchedAt = nowIso()
      row.dispatchedBy = claims.sub
      persist()
      return row
    },
    cancel: async (id: string, token: string): Promise<StockTransferResponse> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const row = getDb().transfers.find(tr => tr.id === id && tr.orgId === claims.orgId)
      if (!row) notFound()
      if (!['PENDING_APPROVAL', 'APPROVED'].includes(row.status)) conflict('Transfer can no longer be cancelled.')
      row.status = 'CANCELLED'
      row.cancelledAt = nowIso()
      row.cancelledBy = claims.sub
      persist()
      return row
    },
    receive: async (id: string, dto: StockTransferReceiveRequest, token: string): Promise<StockTransferResponse> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const db = getDb()
      const row = db.transfers.find(tr => tr.id === id && tr.orgId === claims.orgId)
      if (!row) notFound()
      if (!['IN_TRANSIT', 'PARTIALLY_RECEIVED'].includes(row.status)) conflict('Transfer is not in transit.')
      if (!row.destLocationId) badRequest('Transfer has no destination location.')
      for (const rl of dto.lines) {
        const line = row.lines.find(l => l.id === rl.lineId)
        if (!line) continue
        const factor = rl.uom
          ? (db.uomConversions.find(c => c.variantId === line.variantId && c.uomName === rl.uom)?.factor ?? 1)
          : 1
        const qty = Math.min(Math.round(rl.qtyReceived * factor * 1000) / 1000, line.qtyDispatched - line.qtyReceived)
        if (qty <= 0) continue
        adjustBalance(db, claims.orgId, line.variantId, row.destLocationId, qty)
        db.stockMovements.push({
          id: uid(), orgId: claims.orgId, productId: db.variants.find(v => v.id === line.variantId)?.productId ?? '',
          variantId: line.variantId, locationId: row.destLocationId, movementType: 'TRANSFER_IN', status: 'POSTED',
          delta: qty, uom: null, uomQuantity: null, referenceId: row.id, note: row.reference ?? null,
          createdAt: nowIso(), createdBy: claims.sub, batchId: null, allocations: null,
        })
        line.qtyReceived += qty
        line.qtyInTransit = line.qtyDispatched - line.qtyReceived
      }
      const fullyReceived = row.lines.every(l => l.qtyReceived >= l.qtyDispatched)
      if (fullyReceived || dto.closeShort) {
        row.status = 'COMPLETED'
        row.completedAt = nowIso()
        row.completedBy = claims.sub
        row.lines.forEach(l => { l.qtyInTransit = 0 })
      } else {
        row.status = 'PARTIALLY_RECEIVED'
      }
      persist()
      return row
    },
  },

  sales: {
    list: async (
      token: string,
      filters: { locationId?: string; from?: string; to?: string } = {},
    ): Promise<SaleResponse[]> => {
      await delay()
      const claims = requireRole(token, ...VIEW_ROLES)
      return getDb().sales
        .filter(s => s.orgId === claims.orgId)
        .filter(s => !filters.locationId || s.locationId === filters.locationId)
        .filter(s => !filters.from || s.soldAt >= filters.from)
        .filter(s => !filters.to || s.soldAt <= filters.to)
        .sort((a, b) => b.soldAt.localeCompare(a.soldAt))
    },
    get: async (id: string, token: string): Promise<SaleResponse> => {
      await delay()
      const claims = requireRole(token, ...VIEW_ROLES)
      const row = getDb().sales.find(s => s.id === id && s.orgId === claims.orgId)
      if (!row) notFound()
      return row
    },
    create: async (dto: SaleRequest, token: string): Promise<SaleResponse> => {
      await delay()
      const claims = requireRole(token, ...SELL_ROLES)
      const db = getDb()
      if (!dto.lines.length) badRequest('A sale needs at least one line.')
      const saleId = uid()
      let currency: string | null = null
      const lines: SaleLineResponse[] = []
      for (const l of dto.lines) {
        let variantId = l.variantId ?? null
        let factor = 1
        let uomName: string | null = l.uom ?? null
        let barcode: string | null = null
        if (l.barcode) {
          const bc = db.barcodes.find(b => b.orgId === claims.orgId && b.barcode === l.barcode)
          if (!bc) badRequest(`Unknown barcode ${l.barcode}.`)
          variantId = bc.variantId
          barcode = bc.barcode
          factor = bc.factor ?? 1
          uomName = bc.factor != null && bc.factor !== 1 ? bc.uom : null
        } else if (uomName) {
          factor = db.uomConversions.find(c => c.variantId === variantId && c.uomName === uomName)?.factor ?? 1
        }
        const variant = db.variants.find(v => v.id === variantId && v.orgId === claims.orgId)
        if (!variant) badRequest('Unknown variant on a sale line.')
        if (variant.priceCurrency) currency = currency ?? variant.priceCurrency
        const unitPrice = l.unitPrice ?? (
          uomName
            ? (db.uomConversions.find(c => c.variantId === variant.id && c.uomName === uomName)?.price
                ?? (variant.price != null ? Math.round(variant.price * factor * 100) / 100 : 0))
            : (variant.price ?? 0)
        )
        const qtyBase = Math.round(l.quantity * factor * 1000) / 1000
        const lineTotal = Math.round(unitPrice * l.quantity * 100) / 100
        lines.push({
          id: uid(), variantId: variant.id, barcode,
          qtyBase, uom: uomName, uomQuantity: uomName ? l.quantity : null,
          unitPrice, lineTotal,
        })
        // Deplete stock at the sale location (FEFO for batch-tracked products).
        const product = db.products.find(p => p.id === variant.productId)!
        if (product.tracksBatches) {
          let remaining = qtyBase
          const lots = db.batches
            .filter(b => b.orgId === claims.orgId && b.variantId === variant.id && b.status === 'ACTIVE')
            .filter(b => (b.balances.find(x => x.locationId === dto.locationId)?.quantity ?? 0) > 0)
            .sort((a, b) => (a.expiryDate ?? '9999').localeCompare(b.expiryDate ?? '9999'))
          for (const rec of lots) {
            if (remaining <= 0) break
            const cell = rec.balances.find(x => x.locationId === dto.locationId)!
            const take = Math.min(remaining, cell.quantity)
            cell.quantity -= take
            remaining -= take
          }
        }
        adjustBalance(db, claims.orgId, variant.id, dto.locationId, -qtyBase)
        db.stockMovements.push({
          id: uid(), orgId: claims.orgId, productId: variant.productId, variantId: variant.id, locationId: dto.locationId,
          movementType: 'SALE', status: 'POSTED', delta: -qtyBase, uom: uomName, uomQuantity: uomName ? -l.quantity : null,
          referenceId: saleId, note: dto.reference ?? null, createdAt: nowIso(), createdBy: claims.sub,
          batchId: null, allocations: null,
        })
      }
      const sale: SaleResponse = {
        id: saleId, orgId: claims.orgId, locationId: dto.locationId, reference: dto.reference ?? null,
        status: 'COMPLETED', subtotal: Math.round(lines.reduce((n, l) => n + l.lineTotal, 0) * 100) / 100,
        currency, note: dto.note ?? null, lines, soldAt: nowIso(), soldBy: claims.sub, voidedAt: null, voidedBy: null,
      }
      db.sales.push(sale)
      persist()
      return sale
    },
    ticketPdf: async (id: string, token: string, lang?: string): Promise<Blob> => {
      await delay()
      const claims = requireRole(token, ...VIEW_ROLES)
      const db = getDb()
      const sale = db.sales.find(s => s.id === id && s.orgId === claims.orgId)
      if (!sale) notFound()
      const loc = db.locations.find(l => l.id === sale.locationId)
      const org = db.orgs.find(o => o.id === claims.orgId)
      const ticketLines = sale.lines.map(l => {
        const variant = db.variants.find(v => v.id === l.variantId)
        const product = variant ? db.products.find(p => p.id === variant.productId) : undefined
        const opts = (variant?.options ?? []).map(o => o.value).sort().join(' / ')
        const description = [product?.name ?? variant?.sku ?? l.variantId, opts].filter(Boolean).join(' ')
        const pack = l.uom != null && l.uomQuantity != null
        return {
          description,
          quantity: pack ? l.uomQuantity! : l.qtyBase,
          unit: pack ? l.uom! : (variant?.baseUom ?? 'units'),
          unitPrice: l.unitPrice,
          lineTotal: l.lineTotal,
        }
      })
      return renderSaleTicket({
        companyName: org?.name ?? null,
        locationName: loc?.name ?? null,
        locationCode: loc?.code ?? null,
        reference: sale.reference,
        saleId: sale.id,
        soldAt: sale.soldAt,
        currency: sale.currency,
        subtotal: sale.subtotal,
        note: sale.note,
        lines: ticketLines,
      }, lang === 'es' ? 'es' : 'en')
    },
  },
}
