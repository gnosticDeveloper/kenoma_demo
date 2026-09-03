import type {
  BasePricingResponse,
  BatchStatus,
  BillingHistoryResponse,
  DrBackupResponse,
  ExchangeRateResponse,
  ExportFormat,
  ExportLayout,
  LocationResponse,
  ModulePricingResponse,
  OrgBarcodeSettingsResponse,
  OrgBatchSettingsResponse,
  OrgResponse,
  OrgUnitResponse,
  ProductMetadataResponse,
  ProductResponse,
  ProductVariantResponse,
  SaleResponse,
  ServiceResponse,
  StockAlertThresholdResponse,
  StockBalanceResponse,
  StockMovementResponse,
  StockTransferResponse,
  UomConversionResponse,
  UserResponse,
  VariantBarcodeResponse,
} from '../types'
import { clearSession } from './session'
import { buildSeed } from './seed'
import { LANG_KEY } from '../i18n'
import type { DemoLang } from './presets'
import { uid as genUid } from '../lib/uid'

const DB_KEY = 'kenoma-demo-db-v14'

export function currentLang(): DemoLang {
  return localStorage.getItem(LANG_KEY) === 'es' ? 'es' : 'en'
}

export interface StoredUser extends UserResponse {
  orgId: string
  password: string
}

export interface ExportJobRecord {
  id: string
  orgId: string
  format: ExportFormat
  layout: ExportLayout
  requestedAtMs: number
}

// Production batch / lot. Per-location quantities are tracked here; the API response
// (BatchResponse) is derived from `balances` + `totalQuantity` on read.
export interface BatchRecord {
  id: string
  orgId: string
  variantId: string
  batchCode: string
  expiryDate: string | null
  status: BatchStatus
  recalledAt: string | null
  recallNote: string | null
  createdAt: string
  balances: { locationId: string; quantity: number }[]
}

export interface Db {
  orgs: OrgResponse[]
  billingHistory: BillingHistoryResponse[]
  exportJobs: ExportJobRecord[]
  drBackups: DrBackupResponse[]
  basePricing: BasePricingResponse[]
  modulePricing: ModulePricingResponse[]
  exchangeRates: ExchangeRateResponse[]
  services: ServiceResponse[]
  users: StoredUser[]
  locations: LocationResponse[]
  metadata: ProductMetadataResponse[]
  products: ProductResponse[]
  variants: ProductVariantResponse[]
  stockMovements: StockMovementResponse[]
  stockBalances: StockBalanceResponse[]
  alertThresholds: StockAlertThresholdResponse[]
  units: OrgUnitResponse[]
  uomConversions: UomConversionResponse[]
  barcodes: VariantBarcodeResponse[]
  batches: BatchRecord[]
  transfers: StockTransferResponse[]
  sales: SaleResponse[]
  orgBarcodeSettings: OrgBarcodeSettingsResponse[]
  orgBatchSettings: OrgBatchSettingsResponse[]
}

let cached: Db | null = null

export function getDb(): Db {
  if (cached) return cached
  const raw = localStorage.getItem(DB_KEY)
  if (raw) {
    try {
      cached = JSON.parse(raw) as Db
      return cached
    } catch {
    }
  }
  cached = buildSeed(currentLang())
  persist()
  return cached
}

export function persist(): void {
  if (cached) localStorage.setItem(DB_KEY, JSON.stringify(cached))
}

export function resetDb(): void {
  localStorage.removeItem(DB_KEY)
  clearSession()
  cached = null
}

export function uid(): string {
  return genUid()
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function delay(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 180 + Math.random() * 270))
}
