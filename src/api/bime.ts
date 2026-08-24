import type {
  LocationRequest,
  LocationResponse,
  MetadataOptionPatch,
  NotificationEmailVerifyRequest,
  MetadataOptionRequest,
  MetadataOptionResponse,
  ProductMetadataAssignmentItem,
  ProductMetadataRequest,
  ProductMetadataResponse,
  ProductRequest,
  ProductResponse,
  ProductVariantRequest,
  ProductVariantResponse,
  VariantBatchPriceRequest,
  RoleResponse,
  StockAlertResponse,
  StockAlertThresholdRequest,
  StockAlertThresholdResponse,
  StockBalanceResponse,
  StockMovementRequest,
  StockMovementResponse,
} from '../types'
import { delay, getDb, nowIso, persist, uid } from '../mock/db'
import { requireClaims, requireRole, notFound } from '../mock/authz'
import { BIME_ROLES } from '../mock/roles'

const VIEW_ROLES = ['BIME_ADMIN', 'BIME_VIEWER']
const MANAGE_ROLES = ['BIME_ADMIN']
const CATALOG_ROLES = ['BIME_ADMIN', 'BIME_VIEWER', 'BIME_CATALOG_VIEWER']

function convertPrice(variant: ProductVariantResponse, currency?: string): ProductVariantResponse {
  if (!currency || !variant.price || !variant.priceCurrency || currency === variant.priceCurrency) return variant
  const db = getDb()
  const rate = db.exchangeRates.find(r => r.fromCurrency === variant.priceCurrency && r.toCurrency === currency)
  if (!rate) return variant
  return { ...variant, price: Math.round(variant.price * rate.rate * 100) / 100, priceCurrency: currency }
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
    metadata,
    variants: variants.map(v => ({ ...v, stock: db.stockBalances.filter(b => b.variantId === v.id).map(b => ({ locationId: b.locationId, quantity: b.quantity, modifiedAt: b.modifiedAt })) })),
    variantCount: null,
  }
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
      const option: MetadataOptionResponse = { id: uid(), metadataId: id, value: dto.value, createdAt: nowIso() }
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
        isActive: dto.isActive ?? true, createdAt: nowIso(), modifiedAt: nowIso(), metadata: null, variants: null, variantCount: 0,
      }
      getDb().products.push(row)
      persist()
      return row
    },
    list: async (token: string): Promise<ProductResponse[]> => {
      await delay()
      const claims = requireRole(token, ...CATALOG_ROLES)
      const db = getDb()
      return db.products
        .filter(p => p.orgId === claims.orgId)
        .map(p => ({ ...p, metadata: null, variants: null, variantCount: db.variants.filter(v => v.productId === p.id).length }))
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
      dto.add.forEach(value => meta.options.push({ id: uid(), metadataId, value, createdAt: nowIso() }))
      meta.options = meta.options.filter(o => !dto.remove.includes(o.id))
      persist()
    },
  },

  variants: {
    create: async (productId: string, dto: ProductVariantRequest, token: string): Promise<ProductVariantResponse> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const db = getDb()
      if (!db.products.some(p => p.id === productId && p.orgId === claims.orgId)) notFound()
      const options = db.metadata.flatMap(m => m.options).filter(o => dto.optionIds.includes(o.id))
      const row: ProductVariantResponse = {
        id: uid(), productId, orgId: claims.orgId, sku: dto.sku ?? null, isActive: dto.isActive ?? true,
        createdAt: nowIso(), options, stock: [], price: dto.price ?? null, priceCurrency: dto.priceCurrency ?? null,
      }
      db.variants.push(row)
      persist()
      return row
    },
    list: async (productId: string, token: string, currency?: string): Promise<ProductVariantResponse[]> => {
      await delay()
      const claims = requireRole(token, ...VIEW_ROLES)
      const db = getDb()
      return db.variants
        .filter(v => v.productId === productId && v.orgId === claims.orgId)
        .map(v => convertPrice({ ...v, stock: db.stockBalances.filter(b => b.variantId === v.id).map(b => ({ locationId: b.locationId, quantity: b.quantity, modifiedAt: b.modifiedAt })) }, currency))
    },
    get: async (productId: string, variantId: string, token: string, currency?: string): Promise<ProductVariantResponse> => {
      await delay()
      const claims = requireRole(token, ...VIEW_ROLES)
      const db = getDb()
      const row = db.variants.find(v => v.id === variantId && v.productId === productId && v.orgId === claims.orgId)
      if (!row) notFound()
      return convertPrice({ ...row, stock: db.stockBalances.filter(b => b.variantId === row.id).map(b => ({ locationId: b.locationId, quantity: b.quantity, modifiedAt: b.modifiedAt })) }, currency)
    },
    patch: async (productId: string, variantId: string, dto: ProductVariantRequest, token: string): Promise<ProductVariantResponse> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const db = getDb()
      const row = db.variants.find(v => v.id === variantId && v.productId === productId && v.orgId === claims.orgId)
      if (!row) notFound()
      if (dto.optionIds.length) row.options = db.metadata.flatMap(m => m.options).filter(o => dto.optionIds.includes(o.id))
      if (dto.sku !== undefined) row.sku = dto.sku
      if (dto.isActive !== undefined) row.isActive = dto.isActive
      if (dto.price !== undefined) row.price = dto.price
      if (dto.priceCurrency !== undefined) row.priceCurrency = dto.priceCurrency
      persist()
      return row
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
  },

  stock: {
    recordMovement: async (dto: StockMovementRequest, token: string): Promise<StockMovementResponse> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const db = getDb()
      const variant = db.variants.find(v => v.id === dto.variantId && v.orgId === claims.orgId)
      if (!variant) notFound()
      const movement: StockMovementResponse = {
        id: uid(), orgId: claims.orgId, productId: variant.productId, variantId: dto.variantId, locationId: dto.locationId,
        movementType: dto.movementType, delta: dto.delta, referenceId: dto.referenceId ?? null, note: dto.note ?? null,
        createdAt: nowIso(), createdBy: claims.sub,
      }
      db.stockMovements.push(movement)
      let balance = db.stockBalances.find(b => b.variantId === dto.variantId && b.locationId === dto.locationId)
      const signedDelta = dto.movementType === 'OUTBOUND' ? -Math.abs(dto.delta) : dto.delta
      if (!balance) {
        balance = { orgId: claims.orgId, variantId: dto.variantId, locationId: dto.locationId, quantity: 0, modifiedAt: nowIso() }
        db.stockBalances.push(balance)
      }
      balance.quantity += signedDelta
      balance.modifiedAt = nowIso()
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
    listMovements: async (token: string, filters: { variantId?: string; locationId?: string } = {}): Promise<StockMovementResponse[]> => {
      await delay()
      const claims = requireRole(token, ...VIEW_ROLES)
      return getDb().stockMovements.filter(m =>
        m.orgId === claims.orgId
        && (!filters.variantId || m.variantId === filters.variantId)
        && (!filters.locationId || m.locationId === filters.locationId))
    },
    listBalances: async (token: string, filters: { variantId?: string; locationId?: string } = {}): Promise<StockBalanceResponse[]> => {
      await delay()
      const claims = requireRole(token, ...VIEW_ROLES)
      return getDb().stockBalances.filter(b =>
        b.orgId === claims.orgId
        && (!filters.variantId || b.variantId === filters.variantId)
        && (!filters.locationId || b.locationId === filters.locationId))
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
    listAlertThresholds: async (token: string, filters: { variantId?: string; locationId?: string } = {}): Promise<StockAlertThresholdResponse[]> => {
      await delay()
      const claims = requireRole(token, ...VIEW_ROLES)
      return getDb().alertThresholds.filter(t =>
        t.orgId === claims.orgId
        && (!filters.variantId || t.variantId === filters.variantId)
        && (!filters.locationId || t.locationId === filters.locationId))
    },
    deleteAlertThreshold: async (variantId: string, locationId: string, token: string): Promise<void> => {
      await delay()
      const claims = requireRole(token, ...MANAGE_ROLES)
      const db = getDb()
      db.alertThresholds = db.alertThresholds.filter(t => !(t.variantId === variantId && t.locationId === locationId && t.orgId === claims.orgId))
      persist()
    },
    listActiveAlerts: async (token: string, filters: { variantId?: string; locationId?: string } = {}): Promise<StockAlertResponse[]> => {
      await delay()
      const claims = requireRole(token, ...VIEW_ROLES)
      const db = getDb()
      return db.alertThresholds
        .filter(t => t.orgId === claims.orgId && (!filters.variantId || t.variantId === filters.variantId) && (!filters.locationId || t.locationId === filters.locationId))
        .map(t => {
          const balance = db.stockBalances.find(b => b.variantId === t.variantId && b.locationId === t.locationId)
          return balance && balance.quantity <= t.threshold
            ? { orgId: t.orgId, variantId: t.variantId, locationId: t.locationId, threshold: t.threshold, quantity: balance.quantity, triggeredAt: balance.modifiedAt }
            : null
        })
        .filter((a): a is StockAlertResponse => a !== null)
    },
  },
}
