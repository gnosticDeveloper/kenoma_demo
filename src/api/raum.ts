import type {
  BasePricingRequest,
  BasePricingResponse,
  BasicCredential,
  BillingEmailRequest,
  BillingEmailVerifyRequest,
  BillingHistoryResponse,
  BillingInfoRequest,
  Credentials,
  DrBackupResponse,
  DrBackupScope,
  ExchangeRateRequest,
  ExchangeRateResponse,
  ExportDownloadResponse,
  ExportFormat,
  ExportJobResponse,
  ExportLayout,
  ModulePricingRequest,
  ModulePricingResponse,
  OrgRequest,
  OrgResponse,
  OnboardingRequest,
  PaymentStatusUpdateRequest,
  RoleResponse,
  ServiceRequest,
  ServiceResponse,
} from '../types'
import { currentLang, delay, getDb, nowIso, persist, uid, type ExportJobRecord } from '../mock/db'
import { requireClaims, requireRole, notFound } from '../mock/authz'
import { RAUM_ROLES } from '../mock/roles'
import { seedBimeCatalog } from '../mock/presets'

const EXPORT_RUNNING_AFTER_MS = 900
const EXPORT_DONE_AFTER_MS = 2600

function resolveExportJob(rec: ExportJobRecord): ExportJobResponse {
  const elapsed = Date.now() - rec.requestedAtMs
  const status = elapsed > EXPORT_DONE_AFTER_MS ? 'DONE' : elapsed > EXPORT_RUNNING_AFTER_MS ? 'RUNNING' : 'PENDING'
  return {
    id: rec.id,
    orgId: rec.orgId,
    status,
    format: rec.format,
    layout: rec.layout,
    requestedAt: new Date(rec.requestedAtMs).toISOString(),
    startedAt: elapsed > EXPORT_RUNNING_AFTER_MS ? new Date(rec.requestedAtMs + EXPORT_RUNNING_AFTER_MS).toISOString() : null,
    completedAt: status === 'DONE' ? new Date(rec.requestedAtMs + EXPORT_DONE_AFTER_MS).toISOString() : null,
    errorMessage: null,
  }
}

function findOrg(id: string): OrgResponse {
  const db = getDb()
  const org = db.orgs.find(o => o.id === id)
  if (!org) notFound()
  return org
}

function textBlob(text: string, type: string): Blob {
  return new Blob([text], { type })
}

export const raum = {
  orgs: {
    create: async (dto: OrgRequest, token: string): Promise<OrgResponse> => {
      await delay()
      requireRole(token, 'RAUM_ADMIN')
      const db = getDb()
      const org: OrgResponse = {
        id: uid(), name: dto.name, contactEmail: dto.contactEmail, contactEmailVerified: false,
        taxId: null, fiscalName: null, fiscalAddress: null, billingEmail: null, billingEmailVerified: false,
        billingCycle: null, nextInvoiceDueAt: null, currency: null, currencyRefreshMode: null,
        currencyRefreshCadence: null, currencyRefreshIntervalDays: null, productPricingCurrency: null,
      }
      db.orgs.push(org)
      persist()
      return org
    },
    list: async (token: string): Promise<OrgResponse[]> => {
      await delay()
      requireRole(token, 'RAUM_ADMIN', 'RAUM_ONBOARDING')
      return getDb().orgs
    },
    get: async (id: string, token: string): Promise<OrgResponse> => {
      await delay()
      requireRole(token, 'RAUM_ADMIN', 'RAUM_ONBOARDING')
      return findOrg(id)
    },
    update: async (id: string, dto: OrgRequest, token: string): Promise<OrgResponse> => {
      await delay()
      requireRole(token, 'RAUM_ADMIN')
      const org = findOrg(id)
      org.name = dto.name
      org.contactEmail = dto.contactEmail
      persist()
      return org
    },
    delete: async (id: string, token: string): Promise<void> => {
      await delay()
      requireRole(token, 'RAUM_ADMIN')
      const db = getDb()
      const idx = db.orgs.findIndex(o => o.id === id)
      if (idx === -1) notFound()
      db.orgs.splice(idx, 1)
      persist()
    },
    updateBillingInfo: async (id: string, dto: BillingInfoRequest, token: string): Promise<OrgResponse> => {
      await delay()
      requireRole(token, 'RAUM_ADMIN')
      const org = findOrg(id)
      Object.assign(org, {
        taxId: dto.taxId ?? org.taxId,
        fiscalName: dto.fiscalName ?? org.fiscalName,
        fiscalAddress: dto.fiscalAddress ?? org.fiscalAddress,
        billingCycle: dto.billingCycle || org.billingCycle,
        nextInvoiceDueAt: dto.nextInvoiceDueAt ?? org.nextInvoiceDueAt,
        currency: dto.currency || org.currency,
        currencyRefreshMode: dto.currencyRefreshMode || null,
        currencyRefreshCadence: dto.currencyRefreshCadence || null,
        currencyRefreshIntervalDays: dto.currencyRefreshIntervalDays ?? null,
        productPricingCurrency: dto.productPricingCurrency || org.productPricingCurrency,
      })
      persist()
      return org
    },
    requestBillingEmailVerification: async (id: string, dto: BillingEmailRequest, token: string): Promise<void> => {
      await delay()
      requireRole(token, 'RAUM_ADMIN')
      const org = findOrg(id)
      org.billingEmail = dto.billingEmail
      org.billingEmailVerified = true
      persist()
    },
    confirmBillingEmail: async (_id: string, _dto: BillingEmailVerifyRequest): Promise<void> => { await delay() },
    confirmContactEmail: async (_id: string, _dto: BillingEmailVerifyRequest): Promise<void> => { await delay() },
    requestExport: async (id: string, format: ExportFormat, layout: ExportLayout, token: string): Promise<ExportJobResponse> => {
      await delay()
      requireRole(token, 'RAUM_ADMIN', 'RAUM_OWNER')
      const db = getDb()
      const rec: ExportJobRecord = { id: uid(), orgId: id, format, layout, requestedAtMs: Date.now() }
      db.exportJobs.push(rec)
      persist()
      return resolveExportJob(rec)
    },
    getExportJob: async (id: string, jobId: string, token: string): Promise<ExportJobResponse> => {
      await delay()
      requireRole(token, 'RAUM_ADMIN', 'RAUM_OWNER')
      const rec = getDb().exportJobs.find(j => j.id === jobId && j.orgId === id)
      if (!rec) notFound()
      return resolveExportJob(rec)
    },
    getExportDownloadLinks: async (id: string, jobId: string, token: string): Promise<ExportDownloadResponse> => {
      await delay()
      requireRole(token, 'RAUM_ADMIN', 'RAUM_OWNER')
      const rec = getDb().exportJobs.find(j => j.id === jobId && j.orgId === id)
      if (!rec) notFound()
      return { jobId, files: [{ key: `export-${jobId}-part-1`, index: 0 }] }
    },
    downloadExportFile: async (id: string, jobId: string, index: number, _token: string): Promise<Blob> => {
      await delay()
      return textBlob(`-- Kenoma demo export\n-- org: ${id}\n-- job: ${jobId}\n-- part: ${index}\n`, 'application/sql')
    },
  },
  exportJobs: {
    list: async (token: string): Promise<ExportJobResponse[]> => {
      await delay()
      requireRole(token, 'RAUM_ADMIN')
      return getDb().exportJobs.map(resolveExportJob)
    },
  },
  drBackups: {
    list: async (token: string, scope?: DrBackupScope, orgId?: string): Promise<DrBackupResponse[]> => {
      await delay()
      requireRole(token, 'RAUM_ADMIN')
      return getDb().drBackups.filter(b => (!scope || b.scope === scope) && (!orgId || b.orgId === orgId))
    },
    restore: async (_id: string, token: string): Promise<void> => {
      await delay()
      requireRole(token, 'RAUM_ADMIN')
    },
  },
  billingHistory: {
    list: async (orgId: string, token: string): Promise<BillingHistoryResponse[]> => {
      await delay()
      requireRole(token, 'RAUM_ADMIN')
      return getDb().billingHistory.filter(h => h.orgId === orgId)
    },
    downloadInvoice: async (orgId: string, historyId: string, _token: string): Promise<Blob> => {
      await delay()
      return textBlob(`Kenoma demo invoice\norg: ${orgId}\ninvoice: ${historyId}\n`, 'application/pdf')
    },
    updatePaymentStatus: async (orgId: string, historyId: string, dto: PaymentStatusUpdateRequest, token: string): Promise<BillingHistoryResponse> => {
      await delay()
      requireRole(token, 'RAUM_ADMIN')
      const row = getDb().billingHistory.find(h => h.id === historyId && h.orgId === orgId)
      if (!row) notFound()
      row.paymentStatus = dto.status
      row.paidAt = dto.status === 'PAID' ? nowIso() : null
      row.paymentReference = dto.status === 'PAID' ? (dto.reference ?? null) : null
      row.overdue = dto.status === 'PENDING' ? row.overdue : false
      persist()
      return row
    },
    resendInvoice: async (_orgId: string, _historyId: string, token: string): Promise<void> => {
      await delay()
      requireRole(token, 'RAUM_ADMIN')
    },
  },
  pricing: {
    base: {
      list: async (token: string): Promise<BasePricingResponse[]> => {
        await delay()
        requireRole(token, 'RAUM_ADMIN')
        return getDb().basePricing
      },
      add: async (dto: BasePricingRequest, token: string): Promise<BasePricingResponse> => {
        await delay()
        requireRole(token, 'RAUM_ADMIN')
        const row: BasePricingResponse = { id: uid(), price: dto.price, currency: dto.currency, effectiveFrom: dto.effectiveFrom ?? nowIso(), createdAt: nowIso() }
        getDb().basePricing.push(row)
        persist()
        return row
      },
    },
    modules: {
      list: async (token: string): Promise<ModulePricingResponse[]> => {
        await delay()
        requireRole(token, 'RAUM_ADMIN')
        return getDb().modulePricing
      },
      add: async (dto: ModulePricingRequest, token: string): Promise<ModulePricingResponse> => {
        await delay()
        requireRole(token, 'RAUM_ADMIN')
        const service = getDb().services.find(s => s.id === dto.serviceId)
        const row: ModulePricingResponse = {
          id: uid(), serviceId: dto.serviceId, serviceName: service?.name ?? null, price: dto.price,
          currency: dto.currency, includedInBase: dto.includedInBase, effectiveFrom: dto.effectiveFrom ?? nowIso(), createdAt: nowIso(),
        }
        getDb().modulePricing.push(row)
        persist()
        return row
      },
    },
    exchangeRates: {
      list: async (token: string): Promise<ExchangeRateResponse[]> => {
        await delay()
        requireRole(token, 'RAUM_ADMIN')
        return getDb().exchangeRates
      },
      add: async (dto: ExchangeRateRequest, token: string): Promise<ExchangeRateResponse> => {
        await delay()
        requireRole(token, 'RAUM_ADMIN')
        const row: ExchangeRateResponse = {
          id: uid(), fromCurrency: dto.fromCurrency, toCurrency: dto.toCurrency, rate: dto.rate,
          effectiveFrom: dto.effectiveFrom ?? nowIso(), createdAt: nowIso(),
        }
        getDb().exchangeRates.push(row)
        persist()
        return row
      },
    },
  },
  roles: async (token: string): Promise<RoleResponse[]> => {
    await delay()
    requireClaims(token)
    return RAUM_ROLES
  },
  services: {
    create: async (dto: ServiceRequest, token: string): Promise<ServiceResponse> => {
      await delay()
      requireRole(token, 'RAUM_ADMIN')
      const row: ServiceResponse = { id: uid(), name: dto.name, description: dto.description }
      getDb().services.push(row)
      persist()
      return row
    },
    list: async (token: string): Promise<ServiceResponse[]> => {
      await delay()
      requireClaims(token)
      return getDb().services
    },
    get: async (id: string, token: string): Promise<ServiceResponse> => {
      await delay()
      requireRole(token, 'RAUM_ADMIN')
      const row = getDb().services.find(s => s.id === id)
      if (!row) notFound()
      return row
    },
    update: async (id: string, dto: ServiceRequest, token: string): Promise<ServiceResponse> => {
      await delay()
      requireRole(token, 'RAUM_ADMIN')
      const row = getDb().services.find(s => s.id === id)
      if (!row) notFound()
      row.name = dto.name
      row.description = dto.description
      persist()
      return row
    },
    delete: async (id: string, token: string): Promise<void> => {
      await delay()
      requireRole(token, 'RAUM_ADMIN')
      const db = getDb()
      const idx = db.services.findIndex(s => s.id === id)
      if (idx === -1) notFound()
      db.services.splice(idx, 1)
      persist()
    },
  },
  credentials: {
    register: async (dto: Credentials, token: string): Promise<BasicCredential> => {
      await delay()
      requireRole(token, 'RAUM_ADMIN')
      return { orgId: dto.orgId, serviceId: dto.serviceId }
    },
    ephemeral: async (dto: BasicCredential, token: string): Promise<Credentials> => {
      await delay()
      requireRole(token, 'RAUM_ADMIN')
      const service = getDb().services.find(s => s.id === dto.serviceId)
      return {
        orgId: dto.orgId,
        serviceId: dto.serviceId,
        userName: `demo_${(service?.name ?? 'svc').toLowerCase()}_${uid().slice(0, 8)}`,
        password: uid().replace(/-/g, '').slice(0, 20),
        dbHost: `pg-${(service?.name ?? 'svc').toLowerCase()}.internal`,
        dbPort: 5432,
        dbName: (service?.name ?? 'service').toLowerCase(),
        dbEngine: 'postgresql',
        leaseId: uid(),
        leaseDuration: 3600,
      }
    },
  },
  onboarding: {
    initiate: async (orgId: string, dto: OnboardingRequest, token: string): Promise<void> => {
      await delay()
      requireRole(token, 'RAUM_ADMIN', 'RAUM_ONBOARDING')
      const db = getDb()
      const org = db.orgs.find(o => o.id === orgId)
      if (!org) notFound()
      const services = db.services
      const raumSvc = services.find(s => s.name === 'Raum')
      const vassagoSvc = services.find(s => s.name === 'Vassago')
      const bimeSvc = services.find(s => s.name === 'Bime')
      const roles: Record<string, string[]> = {}
      if (raumSvc) roles[raumSvc.id] = ['RAUM_ADMIN']
      if (vassagoSvc) roles[vassagoSvc.id] = ['VASSAGO_ADMIN']
      if (bimeSvc) roles[bimeSvc.id] = ['BIME_ADMIN']
      db.users.push({
        id: uid(), orgId, name: dto.name, lastName: dto.lastName, email: dto.email,
        username: dto.username, password: 'demo1234', roles,
      })
      if (!db.locations.some(l => l.orgId === orgId)) {
        seedBimeCatalog(db, orgId, dto.bimePreset, currentLang())
      }
      org.contactEmailVerified = true
      persist()
    },
  },
}
