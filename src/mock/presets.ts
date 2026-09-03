import type {
  BimePreset,
  LocationResponse,
  MetadataOptionResponse,
  ProductMetadataResponse,
  ProductResponse,
  ProductVariantResponse,
  StockBalanceResponse,
  StockMovementResponse,
  VariantBarcodeResponse,
} from '../types'
import { nowIso, uid, type BatchRecord, type Db } from './db'

// Deterministic-ish EAN-13 generator for demo seed barcodes. Uses the GS1
// restricted-distribution prefix (02) so they never collide with real GTINs.
let barcodeSeq = 1
function nextEan13(): string {
  const body = ('02' + String(barcodeSeq++).padStart(10, '0')).slice(0, 12)
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3)
  const check = (10 - (sum % 10)) % 10
  return body + check
}

function seedPrimaryBarcode(db: Db, orgId: string, variant: ProductVariantResponse): void {
  const row: VariantBarcodeResponse = {
    id: uid(), orgId, variantId: variant.id, barcode: nextEan13(), symbology: 'EAN13',
    source: 'PROVIDER', uom: variant.baseUom, factor: 1, isPrimary: true, createdAt: nowIso(),
  }
  db.barcodes.push(row)
  variant.barcodes = [row]
}

interface LotSpec {
  code: string
  // days from now; null = no expiry date on the lot
  expiryDays: number | null
  // share of on-hand stock that lands in this lot (the last spec absorbs the remainder)
  frac: number
}

// Durable goods: one lot due soon, one comfortably out.
const DEFAULT_LOT_SPECS: LotSpec[] = [
  { code: 'LOT-A', expiryDays: 21, frac: 0.4 },
  { code: 'LOT-B', expiryDays: 300, frac: 0.6 },
]

// Perishables: a use-first lot right at the edge, a mid lot, and fresher stock.
const PERISHABLE_LOT_SPECS: LotSpec[] = [
  { code: 'LOT-A', expiryDays: 4, frac: 0.25 },
  { code: 'LOT-B', expiryDays: 12, frac: 0.4 },
  { code: 'LOT-C', expiryDays: 45, frac: 0.35 },
]

// Split a whole-number balance across lots by fraction, exactly (remainder to the last lot).
function splitBalance(total: number, fracs: number[]): number[] {
  const out = fracs.map(f => Math.max(0, Math.floor(total * f)))
  const used = out.reduce((a, c) => a + c, 0)
  if (used === 0 && total > 0) {
    out[0] = total
  } else {
    out[out.length - 1] += total - used
  }
  let deficit = out[out.length - 1] < 0 ? -out[out.length - 1] : 0
  if (deficit > 0) {
    out[out.length - 1] = 0
    for (let i = out.length - 2; i >= 0 && deficit > 0; i--) {
      const take = Math.min(out[i], deficit)
      out[i] -= take
      deficit -= take
    }
  }
  return out
}

// Splits a variant's on-hand stock into production lots so the batch/expiry,
// FEFO, near-expiry-alert and recall features have data to show.
function seedBatchesForVariant(
  db: Db, orgId: string, variant: ProductVariantResponse, seq: number,
  specs: LotSpec[] = DEFAULT_LOT_SPECS,
): void {
  const balances = db.stockBalances.filter(b => b.variantId === variant.id && b.quantity > 0)
  if (balances.length === 0) return
  const fracs = specs.map(sp => sp.frac)
  const lots: BatchRecord[] = specs.map(spec => ({
    id: uid(), orgId, variantId: variant.id,
    batchCode: `${spec.code}-${String(seq).padStart(3, '0')}`,
    expiryDate: spec.expiryDays == null
      ? null
      : new Date(Date.now() + spec.expiryDays * 86_400_000).toISOString().slice(0, 10),
    status: 'ACTIVE',
    recalledAt: null, recallNote: null, createdAt: nowIso(),
    balances: [] as { locationId: string; quantity: number }[],
  }))
  for (const b of balances) {
    const parts = splitBalance(b.quantity, fracs)
    lots.forEach((lot, li) => {
      if (parts[li] > 0) lot.balances.push({ locationId: b.locationId, quantity: parts[li] })
    })
  }
  db.batches.push(...lots.filter(l => l.balances.length > 0))
}

export type DemoLang = 'en' | 'es'

function optionCode(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase() || 'OPT'
}

interface PresetBlueprint {
  locationNames: string[]
  currency: string
  metadataGroups: { name: string; options: string[] }[]
  products: { sku: string; name: string; description: string }[]
}

// STORAGE_WAREHOUSE is only reachable via the onboarding preset picker (no
// demo shop uses it), so it keeps the simpler generic seeding path below.
const EN_BLUEPRINTS: Record<'STORAGE_WAREHOUSE', PresetBlueprint> = {
  STORAGE_WAREHOUSE: {
    locationNames: ['Distribution Hub', 'Overflow Yard'],
    currency: 'USD',
    metadataGroups: [
      { name: 'Pallet Type', options: ['Standard', 'Euro', 'Custom'] },
      { name: 'Handling', options: ['Fragile', 'Standard', 'Hazardous'] },
    ],
    products: [
      { sku: 'WHS-001', name: 'Pallet Wrap Roll', description: 'Stretch wrap, 500mm x 300m.' },
      { sku: 'WHS-002', name: 'Steel Shelving Unit', description: '5-tier boltless shelving.' },
      { sku: 'WHS-003', name: 'Cargo Strap Set', description: 'Ratchet straps, set of 4.' },
      { sku: 'WHS-004', name: 'Corner Board Protectors', description: 'Pallet-edge protection, box of 100.' },
      { sku: 'WHS-005', name: 'Freight Dolly', description: '600 lb capacity, swivel casters.' },
      { sku: 'WHS-006', name: 'Barcode Bin Labels', description: 'Weatherproof labels, roll of 500.' },
    ],
  },
}

const ES_BLUEPRINTS: Record<'STORAGE_WAREHOUSE', PresetBlueprint> = {
  STORAGE_WAREHOUSE: {
    locationNames: ['Centro de Distribución', 'Patio de Excedentes'],
    currency: 'ARS',
    metadataGroups: [
      { name: 'Tipo de Pallet', options: ['Estándar', 'Europeo', 'Personalizado'] },
      { name: 'Manipuleo', options: ['Frágil', 'Estándar', 'Peligroso'] },
    ],
    products: [
      { sku: 'WHS-001', name: 'Rollo de Film Stretch', description: 'Film stretch, 500mm x 300m.' },
      { sku: 'WHS-002', name: 'Estantería de Acero', description: 'Estantería de 5 niveles sin tornillos.' },
      { sku: 'WHS-003', name: 'Set de Correas de Carga', description: 'Correas con trinquete, set de 4.' },
      { sku: 'WHS-004', name: 'Protectores de Cantoneras', description: 'Protección de bordes de pallet, caja de 100.' },
      { sku: 'WHS-005', name: 'Zorra de Carga', description: 'Capacidad 270 kg, ruedas giratorias.' },
      { sku: 'WHS-006', name: 'Etiquetas de Código de Barras', description: 'Etiquetas resistentes a la intemperie, rollo de 500.' },
    ],
  },
}

const BLUEPRINTS_BY_LANG: Record<DemoLang, Record<'STORAGE_WAREHOUSE', PresetBlueprint>> = {
  en: EN_BLUEPRINTS,
  es: ES_BLUEPRINTS,
}

// Shared shape for the three "elaborate" presets (books, clothing, repair):
// one variant axis (format/size/warranty) applied uniformly to every item,
// plus several shared metadata groups (author/brand/device-brand, etc.)
// assigned per item from a fixed catalog of real, specific values.
interface CatalogItem {
  sku: string
  name: string
  description: string
  shared: Record<string, string>
}

interface ElaborateBlueprint {
  locationNames: string[]
  currency: string
  variantAxis: { name: string; options: string[] }
  sharedGroups: { name: string; options: string[] }[]
  items: CatalogItem[]
  priceBase: number
  priceStepPerItem: number
  priceStepPerVariant: number
  // Perishable catalogue: every product tracks batches, seeded with the
  // near-edge PERISHABLE_LOT_SPECS instead of the durable-goods default.
  perishable?: boolean
  // Mark one seeded lot (the mid "LOT-B" of items[itemIndex]) recalled, with this note.
  recall?: { itemIndex: number; note: string }
}

const EN_BOOKS: ElaborateBlueprint = {
  locationNames: ['Downtown Branch', 'Back Stockroom'],
  currency: 'USD',
  variantAxis: { name: 'Format', options: ['Paperback', 'Hardcover'] },
  sharedGroups: [
    { name: 'Genre', options: ['Gothic Horror', 'Classic Literature', 'Short Fiction', 'Science Fiction'] },
    { name: 'Author', options: ['Bram Stoker', 'Fyodor Dostoevsky', 'Ryūnosuke Akutagawa', 'Philip K. Dick', 'Edgar Allan Poe', 'Robert A. Heinlein'] },
    { name: 'Editorial', options: ['Penguin Classics', 'Vintage Classics', 'Tuttle Publishing', 'Del Rey', 'Wordsworth Editions', 'Ace Books'] },
    { name: 'Collection', options: ['Gothic Classics', 'Russian Literature', 'Japanese Literature', 'Science Fiction Masters'] },
  ],
  priceBase: 12.99,
  priceStepPerItem: 3,
  priceStepPerVariant: 6,
  items: [
    {
      sku: 'BK-001', name: 'Dracula',
      description: 'Bram Stoker’s gothic horror classic, told through letters and diary entries as Count Dracula stalks Victorian London.',
      shared: { Genre: 'Gothic Horror', Author: 'Bram Stoker', Editorial: 'Penguin Classics', Collection: 'Gothic Classics' },
    },
    {
      sku: 'BK-002', name: 'The Brothers Karamazov',
      description: 'Fyodor Dostoevsky’s final novel — a sprawling story of faith, doubt, and patricide among three brothers.',
      shared: { Genre: 'Classic Literature', Author: 'Fyodor Dostoevsky', Editorial: 'Vintage Classics', Collection: 'Russian Literature' },
    },
    {
      sku: 'BK-003', name: 'Hell Screen',
      description: 'Ryūnosuke Akutagawa’s short story of an artist commissioned to paint a screen depicting hell.',
      shared: { Genre: 'Short Fiction', Author: 'Ryūnosuke Akutagawa', Editorial: 'Penguin Classics', Collection: 'Japanese Literature' },
    },
    {
      sku: 'BK-004', name: 'Rashomon',
      description: 'Ryūnosuke Akutagawa’s short story of a servant weighing survival against morality beneath a ruined city gate.',
      shared: { Genre: 'Short Fiction', Author: 'Ryūnosuke Akutagawa', Editorial: 'Tuttle Publishing', Collection: 'Japanese Literature' },
    },
    {
      sku: 'BK-005', name: 'Do Androids Dream of Electric Sheep?',
      description: 'Philip K. Dick’s noir about a bounty hunter tracking rogue androids in a post-apocalyptic future.',
      shared: { Genre: 'Science Fiction', Author: 'Philip K. Dick', Editorial: 'Del Rey', Collection: 'Science Fiction Masters' },
    },
    {
      sku: 'BK-006', name: 'Tales of Mystery and Imagination',
      description: 'A collection of Edgar Allan Poe’s best-known tales of horror, mystery, and the macabre.',
      shared: { Genre: 'Short Fiction', Author: 'Edgar Allan Poe', Editorial: 'Wordsworth Editions', Collection: 'Gothic Classics' },
    },
    {
      sku: 'BK-007', name: 'Starship Troopers',
      description: 'Robert A. Heinlein’s novel of a young recruit’s rise through a future interstellar military.',
      shared: { Genre: 'Science Fiction', Author: 'Robert A. Heinlein', Editorial: 'Ace Books', Collection: 'Science Fiction Masters' },
    },
  ],
}

const ES_BOOKS: ElaborateBlueprint = {
  locationNames: ['Sucursal Centro', 'Depósito Trasero'],
  currency: 'ARS',
  variantAxis: { name: 'Formato', options: ['Tapa blanda', 'Tapa dura'] },
  sharedGroups: [
    { name: 'Género', options: ['Terror Gótico', 'Literatura Clásica', 'Relato Corto', 'Ciencia Ficción'] },
    { name: 'Autor', options: ['Bram Stoker', 'Fiódor Dostoyevski', 'Ryūnosuke Akutagawa', 'Philip K. Dick', 'Edgar Allan Poe', 'Robert A. Heinlein'] },
    { name: 'Editorial', options: ['Alianza Editorial', 'Editorial Losada', 'Editorial Sudamericana', 'Minotauro', 'Cátedra'] },
    { name: 'Colección', options: ['Clásicos Góticos', 'Literatura Rusa', 'Literatura Japonesa', 'Maestros de la Ciencia Ficción'] },
  ],
  priceBase: 12.99,
  priceStepPerItem: 3,
  priceStepPerVariant: 6,
  items: [
    {
      sku: 'BK-001', name: 'Drácula',
      description: 'El clásico de terror gótico de Bram Stoker, narrado a través de cartas y diarios mientras el Conde Drácula acecha al Londres victoriano.',
      shared: { Género: 'Terror Gótico', Autor: 'Bram Stoker', Editorial: 'Alianza Editorial', Colección: 'Clásicos Góticos' },
    },
    {
      sku: 'BK-002', name: 'Los Hermanos Karamázov',
      description: 'La última novela de Fiódor Dostoyevski: una historia sobre la fe, la duda y el parricidio entre tres hermanos.',
      shared: { Género: 'Literatura Clásica', Autor: 'Fiódor Dostoyevski', Editorial: 'Editorial Losada', Colección: 'Literatura Rusa' },
    },
    {
      sku: 'BK-003', name: 'El Biombo del Infierno',
      description: 'El relato de Ryūnosuke Akutagawa sobre un pintor encargado de retratar el infierno en un biombo.',
      shared: { Género: 'Relato Corto', Autor: 'Ryūnosuke Akutagawa', Editorial: 'Editorial Sudamericana', Colección: 'Literatura Japonesa' },
    },
    {
      sku: 'BK-004', name: 'Rashomon',
      description: 'El relato de Ryūnosuke Akutagawa sobre un sirviente que sopesa la supervivencia frente a la moral bajo una puerta en ruinas.',
      shared: { Género: 'Relato Corto', Autor: 'Ryūnosuke Akutagawa', Editorial: 'Editorial Sudamericana', Colección: 'Literatura Japonesa' },
    },
    {
      sku: 'BK-005', name: '¿Sueñan los Androides con Ovejas Eléctricas?',
      description: 'La novela negra de Philip K. Dick sobre un cazarrecompensas que persigue androides fugitivos en un futuro posapocalíptico.',
      shared: { Género: 'Ciencia Ficción', Autor: 'Philip K. Dick', Editorial: 'Minotauro', Colección: 'Maestros de la Ciencia Ficción' },
    },
    {
      sku: 'BK-006', name: 'Narraciones Extraordinarias',
      description: 'Una colección de los relatos más célebres de Edgar Allan Poe sobre el horror, el misterio y lo macabro.',
      shared: { Género: 'Relato Corto', Autor: 'Edgar Allan Poe', Editorial: 'Cátedra', Colección: 'Clásicos Góticos' },
    },
    {
      sku: 'BK-007', name: 'Tropas del Espacio',
      description: 'La novela de Robert A. Heinlein sobre el ascenso de un joven recluta en un futuro ejército interestelar.',
      shared: { Género: 'Ciencia Ficción', Autor: 'Robert A. Heinlein', Editorial: 'Minotauro', Colección: 'Maestros de la Ciencia Ficción' },
    },
  ],
}

const EN_CLOTHING: ElaborateBlueprint = {
  locationNames: ['Main Store', 'Warehouse Annex'],
  currency: 'USD',
  variantAxis: { name: 'Size', options: ['M', 'L'] },
  sharedGroups: [
    { name: 'Color', options: ['Charcoal', 'Oatmeal', 'Denim Blue', 'Olive', 'Indigo', 'Khaki'] },
    { name: 'Brand', options: ['Loom & Aster', 'Northbound Apparel', 'Fielding & Vance'] },
    { name: 'Material', options: ['Organic Cotton', 'Merino Wool', 'Sherpa Fleece', 'Ripstop Nylon', 'Selvedge Denim', 'Cotton Twill'] },
    { name: 'Collection', options: ['Core Basics', 'Fall/Winter 2025', 'Heritage Line', 'Trailhead'] },
  ],
  priceBase: 24.99,
  priceStepPerItem: 6,
  priceStepPerVariant: 4,
  items: [
    {
      sku: 'CLO-001', name: 'Waffle-Knit Henley',
      description: 'A midweight waffle-knit henley in brushed organic cotton, cut for a relaxed everyday fit.',
      shared: { Color: 'Charcoal', Brand: 'Loom & Aster', Material: 'Organic Cotton', Collection: 'Core Basics' },
    },
    {
      sku: 'CLO-002', name: 'Merino Crewneck Sweater',
      description: 'Fine-gauge merino crewneck with ribbed cuffs and hem, spun from ethically sourced wool.',
      shared: { Color: 'Oatmeal', Brand: 'Loom & Aster', Material: 'Merino Wool', Collection: 'Fall/Winter 2025' },
    },
    {
      sku: 'CLO-003', name: 'Sherpa-Lined Trucker Jacket',
      description: 'Classic trucker silhouette lined in sherpa fleece for cold-weather layering.',
      shared: { Color: 'Denim Blue', Brand: 'Northbound Apparel', Material: 'Sherpa Fleece', Collection: 'Fall/Winter 2025' },
    },
    {
      sku: 'CLO-004', name: 'Ripstop Field Jacket',
      description: 'Lightweight ripstop field jacket with articulated shoulders and four cargo pockets.',
      shared: { Color: 'Olive', Brand: 'Northbound Apparel', Material: 'Ripstop Nylon', Collection: 'Trailhead' },
    },
    {
      sku: 'CLO-005', name: 'Selvedge Denim Jeans',
      description: 'Straight-leg jeans woven on vintage shuttle looms from 13oz selvedge denim.',
      shared: { Color: 'Indigo', Brand: 'Fielding & Vance', Material: 'Selvedge Denim', Collection: 'Heritage Line' },
    },
    {
      sku: 'CLO-006', name: 'Cotton Twill Chinos',
      description: 'Tailored cotton twill chinos with a tapered leg and reinforced knee stitching.',
      shared: { Color: 'Khaki', Brand: 'Fielding & Vance', Material: 'Cotton Twill', Collection: 'Core Basics' },
    },
  ],
}

const ES_CLOTHING: ElaborateBlueprint = {
  locationNames: ['Tienda Principal', 'Depósito Anexo'],
  currency: 'ARS',
  variantAxis: { name: 'Talle', options: ['M', 'L'] },
  sharedGroups: [
    { name: 'Color', options: ['Gris Carbón', 'Crudo', 'Azul Denim', 'Oliva', 'Índigo', 'Caqui'] },
    { name: 'Marca', options: ['Loom & Aster', 'Northbound Apparel', 'Fielding & Vance'] },
    { name: 'Material', options: ['Algodón Orgánico', 'Lana Merino', 'Polar Sherpa', 'Nylon Ripstop', 'Denim Selvedge', 'Gabardina de Algodón'] },
    { name: 'Colección', options: ['Básicos Core', 'Otoño/Invierno 2025', 'Línea Heritage', 'Trailhead'] },
  ],
  priceBase: 24.99,
  priceStepPerItem: 6,
  priceStepPerVariant: 4,
  items: [
    {
      sku: 'CLO-001', name: 'Henley de Punto Waffle',
      description: 'Henley de punto waffle en algodón orgánico cepillado, con corte relajado para uso diario.',
      shared: { Color: 'Gris Carbón', Marca: 'Loom & Aster', Material: 'Algodón Orgánico', Colección: 'Básicos Core' },
    },
    {
      sku: 'CLO-002', name: 'Sweater Merino Cuello Redondo',
      description: 'Sweater de lana merino de calibre fino con puños y ruedo acanalados, de lana de origen ético.',
      shared: { Color: 'Crudo', Marca: 'Loom & Aster', Material: 'Lana Merino', Colección: 'Otoño/Invierno 2025' },
    },
    {
      sku: 'CLO-003', name: 'Campera Trucker con Sherpa',
      description: 'Campera trucker clásica forrada en polar sherpa para abrigo en climas fríos.',
      shared: { Color: 'Azul Denim', Marca: 'Northbound Apparel', Material: 'Polar Sherpa', Colección: 'Otoño/Invierno 2025' },
    },
    {
      sku: 'CLO-004', name: 'Campera de Campo Ripstop',
      description: 'Campera de campo liviana en nylon ripstop con hombros articulados y cuatro bolsillos cargo.',
      shared: { Color: 'Oliva', Marca: 'Northbound Apparel', Material: 'Nylon Ripstop', Colección: 'Trailhead' },
    },
    {
      sku: 'CLO-005', name: 'Jean de Denim Selvedge',
      description: 'Jean recto tejido en telares de lanzadera vintage con denim selvedge de 13oz.',
      shared: { Color: 'Índigo', Marca: 'Fielding & Vance', Material: 'Denim Selvedge', Colección: 'Línea Heritage' },
    },
    {
      sku: 'CLO-006', name: 'Chino de Gabardina',
      description: 'Chino de gabardina de algodón entallado con pierna cónica y refuerzo en la rodilla.',
      shared: { Color: 'Caqui', Marca: 'Fielding & Vance', Material: 'Gabardina de Algodón', Colección: 'Básicos Core' },
    },
  ],
}

const EN_REPAIR: ElaborateBlueprint = {
  locationNames: ['Service Center', 'Parts Storage'],
  currency: 'USD',
  variantAxis: { name: 'Warranty', options: ['90 Days', '1 Year'] },
  sharedGroups: [
    { name: 'Category', options: ['Screen Repair', 'Battery Service', 'Charging Repair'] },
    { name: 'Device Brand', options: ['Apple', 'Samsung', 'Google'] },
    { name: 'Device Model', options: ['iPhone 14', 'Galaxy S23', 'Pixel 8'] },
    { name: 'Parts Supplier', options: ['Apple Genuine Parts Program', 'Samsung OEM Parts', 'iFixit Certified Parts'] },
  ],
  priceBase: 39.99,
  priceStepPerItem: 10,
  priceStepPerVariant: 8,
  items: [
    {
      sku: 'RPR-001', name: 'iPhone 14 Screen Replacement',
      description: 'OEM-spec display assembly replacement for iPhone 14, including True Tone calibration.',
      shared: { Category: 'Screen Repair', 'Device Brand': 'Apple', 'Device Model': 'iPhone 14', 'Parts Supplier': 'Apple Genuine Parts Program' },
    },
    {
      sku: 'RPR-002', name: 'iPhone 14 Battery Replacement',
      description: 'Battery swap for iPhone 14 restoring full-cycle capacity and accurate health reporting.',
      shared: { Category: 'Battery Service', 'Device Brand': 'Apple', 'Device Model': 'iPhone 14', 'Parts Supplier': 'Apple Genuine Parts Program' },
    },
    {
      sku: 'RPR-003', name: 'Galaxy S23 Screen Replacement',
      description: 'AMOLED panel replacement for Galaxy S23 with factory-matched color calibration.',
      shared: { Category: 'Screen Repair', 'Device Brand': 'Samsung', 'Device Model': 'Galaxy S23', 'Parts Supplier': 'Samsung OEM Parts' },
    },
    {
      sku: 'RPR-004', name: 'Galaxy S23 Battery Replacement',
      description: 'Battery replacement for Galaxy S23 to resolve rapid drain and unexpected shutdowns.',
      shared: { Category: 'Battery Service', 'Device Brand': 'Samsung', 'Device Model': 'Galaxy S23', 'Parts Supplier': 'Samsung OEM Parts' },
    },
    {
      sku: 'RPR-005', name: 'Pixel 8 Screen Replacement',
      description: 'Full display assembly replacement for Pixel 8 sourced from certified parts stock.',
      shared: { Category: 'Screen Repair', 'Device Brand': 'Google', 'Device Model': 'Pixel 8', 'Parts Supplier': 'iFixit Certified Parts' },
    },
    {
      sku: 'RPR-006', name: 'Pixel 8 Charging Port Repair',
      description: 'Charging port and flex cable replacement to fix intermittent or failed charging.',
      shared: { Category: 'Charging Repair', 'Device Brand': 'Google', 'Device Model': 'Pixel 8', 'Parts Supplier': 'iFixit Certified Parts' },
    },
  ],
}

const ES_REPAIR: ElaborateBlueprint = {
  locationNames: ['Centro de Servicio', 'Depósito de Repuestos'],
  currency: 'ARS',
  variantAxis: { name: 'Garantía', options: ['90 días', '1 año'] },
  sharedGroups: [
    { name: 'Categoría', options: ['Reparación de Pantalla', 'Servicio de Batería', 'Reparación de Carga'] },
    { name: 'Marca del Dispositivo', options: ['Apple', 'Samsung', 'Google'] },
    { name: 'Modelo', options: ['iPhone 14', 'Galaxy S23', 'Pixel 8'] },
    { name: 'Proveedor de Repuestos', options: ['Apple Genuine Parts Program', 'Samsung OEM Parts', 'iFixit Certified Parts'] },
  ],
  priceBase: 39.99,
  priceStepPerItem: 10,
  priceStepPerVariant: 8,
  items: [
    {
      sku: 'RPR-001', name: 'Reemplazo de Pantalla iPhone 14',
      description: 'Reemplazo de módulo de pantalla con especificación OEM para iPhone 14, incluye calibración True Tone.',
      shared: { Categoría: 'Reparación de Pantalla', 'Marca del Dispositivo': 'Apple', Modelo: 'iPhone 14', 'Proveedor de Repuestos': 'Apple Genuine Parts Program' },
    },
    {
      sku: 'RPR-002', name: 'Reemplazo de Batería iPhone 14',
      description: 'Cambio de batería para iPhone 14 que restaura la capacidad de ciclo completo y el reporte de estado.',
      shared: { Categoría: 'Servicio de Batería', 'Marca del Dispositivo': 'Apple', Modelo: 'iPhone 14', 'Proveedor de Repuestos': 'Apple Genuine Parts Program' },
    },
    {
      sku: 'RPR-003', name: 'Reemplazo de Pantalla Galaxy S23',
      description: 'Reemplazo de panel AMOLED para Galaxy S23 con calibración de color de fábrica.',
      shared: { Categoría: 'Reparación de Pantalla', 'Marca del Dispositivo': 'Samsung', Modelo: 'Galaxy S23', 'Proveedor de Repuestos': 'Samsung OEM Parts' },
    },
    {
      sku: 'RPR-004', name: 'Reemplazo de Batería Galaxy S23',
      description: 'Reemplazo de batería para Galaxy S23 que resuelve descarga rápida y apagados inesperados.',
      shared: { Categoría: 'Servicio de Batería', 'Marca del Dispositivo': 'Samsung', Modelo: 'Galaxy S23', 'Proveedor de Repuestos': 'Samsung OEM Parts' },
    },
    {
      sku: 'RPR-005', name: 'Reemplazo de Pantalla Pixel 8',
      description: 'Reemplazo completo del módulo de pantalla para Pixel 8 con repuestos certificados.',
      shared: { Categoría: 'Reparación de Pantalla', 'Marca del Dispositivo': 'Google', Modelo: 'Pixel 8', 'Proveedor de Repuestos': 'iFixit Certified Parts' },
    },
    {
      sku: 'RPR-006', name: 'Reparación de Puerto de Carga Pixel 8',
      description: 'Reemplazo del puerto de carga y cable flex para resolver fallas de carga intermitente.',
      shared: { Categoría: 'Reparación de Carga', 'Marca del Dispositivo': 'Google', Modelo: 'Pixel 8', 'Proveedor de Repuestos': 'iFixit Certified Parts' },
    },
  ],
}

const EN_GROCERY: ElaborateBlueprint = {
  locationNames: ['Market Floor', 'Cold Store'],
  currency: 'USD',
  perishable: true,
  recall: { itemIndex: 4, note: 'Supplier recall notice: this production lot may be contaminated with Listeria monocytogenes. Pull all remaining units from sale and quarantine pending destruction.' },
  variantAxis: { name: 'Pack Size', options: ['Single', 'Family'] },
  sharedGroups: [
    { name: 'Category', options: ['Dairy', 'Bakery', 'Eggs', 'Beverages', 'Meat'] },
    { name: 'Brand', options: ['Meadowlark', 'Pastoral Co.', 'Sunhaven', 'Golden Crust'] },
    { name: 'Supplier', options: ['Valley Fresh Distribution', 'Harbor Foods', 'Greenfield Farms'] },
    { name: 'Storage', options: ['Refrigerated', 'Ambient', 'Frozen'] },
  ],
  priceBase: 3.49,
  priceStepPerItem: 1.2,
  priceStepPerVariant: 2.4,
  items: [
    {
      sku: 'GRO-001', name: 'Whole Milk',
      description: 'Pasteurised whole cow\u2019s milk, 3.5% fat. Keep refrigerated; best within 7 days of opening.',
      shared: { Category: 'Dairy', Brand: 'Meadowlark', Supplier: 'Valley Fresh Distribution', Storage: 'Refrigerated' },
    },
    {
      sku: 'GRO-002', name: 'Greek-Style Yogurt',
      description: 'Strained natural yogurt, unsweetened, live cultures. Refrigerated shelf life about three weeks.',
      shared: { Category: 'Dairy', Brand: 'Pastoral Co.', Supplier: 'Valley Fresh Distribution', Storage: 'Refrigerated' },
    },
    {
      sku: 'GRO-003', name: 'Free-Range Eggs',
      description: 'Grade A large free-range hen eggs. Sold by the half-dozen or the dozen.',
      shared: { Category: 'Eggs', Brand: 'Sunhaven', Supplier: 'Greenfield Farms', Storage: 'Refrigerated' },
    },
    {
      sku: 'GRO-004', name: 'Sourdough Loaf',
      description: 'Naturally leavened sourdough, baked daily. No preservatives; eat within three days.',
      shared: { Category: 'Bakery', Brand: 'Golden Crust', Supplier: 'Harbor Foods', Storage: 'Ambient' },
    },
    {
      sku: 'GRO-005', name: 'Brie-Style Soft Cheese',
      description: 'Bloomy-rind soft cheese made from pasteurised milk. Ripens in the fridge; serve at room temperature.',
      shared: { Category: 'Dairy', Brand: 'Pastoral Co.', Supplier: 'Harbor Foods', Storage: 'Refrigerated' },
    },
    {
      sku: 'GRO-006', name: 'Fresh Orange Juice',
      description: 'Not-from-concentrate squeezed orange juice, pasteurised. Keep cold; shake before serving.',
      shared: { Category: 'Beverages', Brand: 'Sunhaven', Supplier: 'Valley Fresh Distribution', Storage: 'Refrigerated' },
    },
    {
      sku: 'GRO-007', name: 'Chicken Breast Fillets',
      description: 'Boneless skinless chicken breast fillets, individually quick-frozen. Cook from frozen or thaw in the fridge.',
      shared: { Category: 'Meat', Brand: 'Meadowlark', Supplier: 'Greenfield Farms', Storage: 'Frozen' },
    },
  ],
}

const ES_GROCERY: ElaborateBlueprint = {
  locationNames: ['Sal\u00f3n de Ventas', 'C\u00e1mara Fr\u00eda'],
  currency: 'ARS',
  perishable: true,
  recall: { itemIndex: 4, note: 'Aviso de retiro del proveedor: este lote de producción podría estar contaminado con Listeria monocytogenes. Retirar de la venta todas las unidades y ponerlas en cuarentena hasta su destrucción.' },
  variantAxis: { name: 'Tama\u00f1o', options: ['Individual', 'Familiar'] },
  sharedGroups: [
    { name: 'Categor\u00eda', options: ['L\u00e1cteos', 'Panader\u00eda', 'Huevos', 'Bebidas', 'Carnes'] },
    { name: 'Marca', options: ['Meadowlark', 'Pastoral Co.', 'Sunhaven', 'Golden Crust'] },
    { name: 'Proveedor', options: ['Distribuidora Valle Fresco', 'Alimentos del Puerto', 'Granjas Campoverde'] },
    { name: 'Conservaci\u00f3n', options: ['Refrigerado', 'Ambiente', 'Congelado'] },
  ],
  priceBase: 3.49,
  priceStepPerItem: 1.2,
  priceStepPerVariant: 2.4,
  items: [
    {
      sku: 'GRO-001', name: 'Leche Entera',
      description: 'Leche de vaca entera pasteurizada, 3,5% de grasa. Mantener refrigerada; consumir dentro de los 7 d\u00edas de abierta.',
      shared: { 'Categor\u00eda': 'L\u00e1cteos', Marca: 'Meadowlark', Proveedor: 'Distribuidora Valle Fresco', 'Conservaci\u00f3n': 'Refrigerado' },
    },
    {
      sku: 'GRO-002', name: 'Yogur Griego',
      description: 'Yogur natural colado, sin az\u00facar, con cultivos vivos. Vida \u00fatil refrigerada de unas tres semanas.',
      shared: { 'Categor\u00eda': 'L\u00e1cteos', Marca: 'Pastoral Co.', Proveedor: 'Distribuidora Valle Fresco', 'Conservaci\u00f3n': 'Refrigerado' },
    },
    {
      sku: 'GRO-003', name: 'Huevos de Campo',
      description: 'Huevos de gallina camperos, tama\u00f1o grande. Se venden por media docena o por docena.',
      shared: { 'Categor\u00eda': 'Huevos', Marca: 'Sunhaven', Proveedor: 'Granjas Campoverde', 'Conservaci\u00f3n': 'Refrigerado' },
    },
    {
      sku: 'GRO-004', name: 'Pan de Masa Madre',
      description: 'Pan de fermentaci\u00f3n natural, horneado a diario. Sin conservantes; consumir dentro de los tres d\u00edas.',
      shared: { 'Categor\u00eda': 'Panader\u00eda', Marca: 'Golden Crust', Proveedor: 'Alimentos del Puerto', 'Conservaci\u00f3n': 'Ambiente' },
    },
    {
      sku: 'GRO-005', name: 'Queso Brie',
      description: 'Queso blando de corteza florida elaborado con leche pasteurizada. Madura en la heladera; servir a temperatura ambiente.',
      shared: { 'Categor\u00eda': 'L\u00e1cteos', Marca: 'Pastoral Co.', Proveedor: 'Alimentos del Puerto', 'Conservaci\u00f3n': 'Refrigerado' },
    },
    {
      sku: 'GRO-006', name: 'Jugo de Naranja Exprimido',
      description: 'Jugo de naranja exprimido, no de concentrado, pasteurizado. Mantener fr\u00edo; agitar antes de servir.',
      shared: { 'Categor\u00eda': 'Bebidas', Marca: 'Sunhaven', Proveedor: 'Distribuidora Valle Fresco', 'Conservaci\u00f3n': 'Refrigerado' },
    },
    {
      sku: 'GRO-007', name: 'Suprema de Pollo',
      description: 'Supremas de pollo sin piel ni hueso, congeladas individualmente. Cocinar congeladas o descongelar en la heladera.',
      shared: { 'Categor\u00eda': 'Carnes', Marca: 'Meadowlark', Proveedor: 'Granjas Campoverde', 'Conservaci\u00f3n': 'Congelado' },
    },
  ],
}

export type ElaboratePreset = 'BOOK_STORE' | 'CLOTHING_STORE' | 'REPAIR_SHOP' | 'GROCERY_STORE'

const ELABORATE_BLUEPRINTS: Record<DemoLang, Record<ElaboratePreset, ElaborateBlueprint>> = {
  en: { BOOK_STORE: EN_BOOKS, CLOTHING_STORE: EN_CLOTHING, REPAIR_SHOP: EN_REPAIR, GROCERY_STORE: EN_GROCERY },
  es: { BOOK_STORE: ES_BOOKS, CLOTHING_STORE: ES_CLOTHING, REPAIR_SHOP: ES_REPAIR, GROCERY_STORE: ES_GROCERY },
}

function seedLocations(db: Db, orgId: string, locationNames: string[]): LocationResponse[] {
  const locations: LocationResponse[] = locationNames.map((name, i) => ({
    id: uid(),
    orgId,
    name,
    code: name.slice(0, 3).toUpperCase() + (i + 1),
    isActive: true,
    notificationEmail: null,
    notificationEmailVerified: null,
    createdAt: nowIso(),
    modifiedAt: nowIso(),
  }))
  db.locations.push(...locations)
  return locations
}

// Base prices below are authored in USD. ARS retail prices run several
// orders of magnitude higher, so scale and round to a clean local amount.
function localizePrice(usdPrice: number, currency: string): number {
  if (currency === 'ARS') return Math.round(usdPrice * 1000 / 50) * 50
  return Math.round(usdPrice * 100) / 100
}

function seedStock(db: Db, orgId: string, productId: string, variantId: string, locations: LocationResponse[], idx: number, i: number): void {
  locations.forEach((location, locIdx) => {
    const quantity = Math.max(4, 42 - locIdx * 16 - i * 6 + idx * 2)

    const movement: StockMovementResponse = {
      id: uid(),
      orgId,
      productId,
      variantId,
      locationId: location.id,
      movementType: 'INBOUND',
      status: 'POSTED',
      delta: quantity,
      uom: null,
      uomQuantity: null,
      referenceId: null,
      note: 'Initial stock',
      createdAt: nowIso(),
      createdBy: 'system',
      batchId: null,
      allocations: null,
    }
    db.stockMovements.push(movement)

    const balance: StockBalanceResponse = {
      orgId,
      variantId,
      locationId: location.id,
      quantity,
      modifiedAt: nowIso(),
    }
    db.stockBalances.push(balance)
  })
}

function seedElaborateCatalog(db: Db, orgId: string, bp: ElaborateBlueprint): void {
  const locations = seedLocations(db, orgId, bp.locationNames)

  function makeMetadata(name: string, values: string[]): ProductMetadataResponse {
    const m: ProductMetadataResponse = { id: uid(), orgId, name, options: [], createdAt: nowIso() }
    m.options = values.map(value => ({ id: uid(), metadataId: m.id, value, code: optionCode(value), createdAt: nowIso() }))
    db.metadata.push(m)
    return m
  }

  const axisMeta = makeMetadata(bp.variantAxis.name, bp.variantAxis.options)
  const sharedMeta = bp.sharedGroups.map(g => makeMetadata(g.name, g.options))

  function optionFor(meta: ProductMetadataResponse, value: string): MetadataOptionResponse {
    return meta.options.find(o => o.value === value)!
  }

  const perishable = !!bp.perishable

  bp.items.forEach((item, idx) => {
    const productId = uid()
    const sharedOptions = sharedMeta.map(meta => optionFor(meta, item.shared[meta.name]))
    // A perishable catalogue tracks every product; otherwise just the first, so the
    // batch/expiry/recall/FEFO features always have some data to show.
    const tracksBatches = perishable || idx === 0

    const product: ProductResponse = {
      id: productId,
      orgId,
      sku: item.sku,
      name: item.name,
      description: item.description,
      isActive: true,
      tracksBatches,
      createdAt: nowIso(),
      modifiedAt: nowIso(),
      metadata: null,
      variants: null,
      variantCount: bp.variantAxis.options.length,
    }
    db.products.push(product)

    bp.variantAxis.options.forEach((axisValue, i) => {
      const variantId = uid()
      const variant: ProductVariantResponse = {
        id: variantId,
        productId,
        orgId,
        sku: `${item.sku}-${i + 1}`,
        isActive: true,
        createdAt: nowIso(),
        options: [...sharedOptions, optionFor(axisMeta, axisValue)],
        stock: [],
        price: localizePrice(bp.priceBase + idx * bp.priceStepPerItem + i * bp.priceStepPerVariant, bp.currency),
        priceCurrency: bp.currency,
        cost: localizePrice((bp.priceBase + idx * bp.priceStepPerItem + i * bp.priceStepPerVariant) * 0.55, bp.currency),
        costCurrency: bp.currency,
        baseUom: 'units',
        uomConversions: [],
        barcodes: [],
      }
      db.variants.push(variant)
      seedStock(db, orgId, productId, variantId, locations, idx, i)
      seedPrimaryBarcode(db, orgId, variant)
      if (tracksBatches) {
        seedBatchesForVariant(db, orgId, variant, idx * 10 + i, perishable ? PERISHABLE_LOT_SPECS : DEFAULT_LOT_SPECS)
      }
    })
  })

  if (bp.recall) {
    const targetSku = bp.items[bp.recall.itemIndex]?.sku
    const targetVariantIds = new Set(
      db.variants.filter(v => db.products.find(p => p.id === v.productId)?.sku === targetSku).map(v => v.id),
    )
    const lot = db.batches.find(b => targetVariantIds.has(b.variantId) && b.batchCode.startsWith('LOT-B'))
    if (lot) {
      lot.status = 'RECALLED'
      lot.recalledAt = nowIso()
      lot.recallNote = bp.recall.note
    }
  }
}

export function seedBimeCatalog(db: Db, orgId: string, preset: BimePreset | ElaboratePreset, lang: DemoLang): void {
  if (preset === 'BOOK_STORE' || preset === 'CLOTHING_STORE' || preset === 'REPAIR_SHOP' || preset === 'GROCERY_STORE') {
    seedElaborateCatalog(db, orgId, ELABORATE_BLUEPRINTS[lang][preset])
    return
  }

  const bp = BLUEPRINTS_BY_LANG[lang][preset]
  const locations = seedLocations(db, orgId, bp.locationNames)

  const metadata: ProductMetadataResponse[] = bp.metadataGroups.map(group => ({
    id: uid(),
    orgId,
    name: group.name,
    options: group.options.map(value => ({ id: uid(), metadataId: '', value, code: optionCode(value), createdAt: nowIso() })),
    createdAt: nowIso(),
  }))
  metadata.forEach(m => m.options.forEach(o => { o.metadataId = m.id }))
  db.metadata.push(...metadata)

  const primaryMetadata = metadata[0]

  bp.products.forEach((p, idx) => {
    const productId = uid()
    const product: ProductResponse = {
      id: productId,
      orgId,
      sku: p.sku,
      name: p.name,
      description: p.description,
      isActive: true,
      tracksBatches: false,
      createdAt: nowIso(),
      modifiedAt: nowIso(),
      metadata: null,
      variants: null,
      variantCount: primaryMetadata ? Math.min(2, primaryMetadata.options.length) : 0,
    }
    db.products.push(product)

    const optionCount = primaryMetadata ? Math.min(2, primaryMetadata.options.length) : 1
    for (let i = 0; i < optionCount; i++) {
      const option = primaryMetadata?.options[i]
      const variantId = uid()
      const variant: ProductVariantResponse = {
        id: variantId,
        productId,
        orgId,
        sku: `${p.sku}-${i + 1}`,
        isActive: true,
        createdAt: nowIso(),
        options: option ? [option] : [],
        stock: [],
        price: localizePrice(19.99 + idx * 5 + i * 2, bp.currency),
        priceCurrency: bp.currency,
        cost: localizePrice((19.99 + idx * 5 + i * 2) * 0.55, bp.currency),
        costCurrency: bp.currency,
        baseUom: 'units',
        uomConversions: [],
        barcodes: [],
      }
      db.variants.push(variant)
      seedStock(db, orgId, productId, variantId, locations, idx, i)
      seedPrimaryBarcode(db, orgId, variant)
    }
  })
}
