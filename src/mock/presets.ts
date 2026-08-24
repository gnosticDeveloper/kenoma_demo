import type {
  BimePreset,
  LocationResponse,
  ProductMetadataResponse,
  ProductResponse,
  ProductVariantResponse,
  StockBalanceResponse,
  StockMovementResponse,
} from '../types'
import { nowIso, uid, type Db } from './db'

export type DemoLang = 'en' | 'es'

interface PresetBlueprint {
  locationNames: string[]
  currency: string
  metadataGroups: { name: string; options: string[] }[]
  products: { sku: string; name: string; description: string }[]
}

const EN_BLUEPRINTS: Record<BimePreset, PresetBlueprint> = {
  CLOTHING_STORE: {
    locationNames: ['Main Store', 'Warehouse Annex'],
    currency: 'USD',
    metadataGroups: [
      { name: 'Size', options: ['XS', 'S', 'M', 'L', 'XL'] },
      { name: 'Color', options: ['Black', 'White', 'Red', 'Blue'] },
    ],
    products: [
      { sku: 'TEE-001', name: 'Classic Tee', description: 'Crewneck cotton t-shirt.' },
      { sku: 'JNS-002', name: 'Slim Jeans', description: 'Mid-rise slim-fit denim.' },
      { sku: 'HOD-003', name: 'Hooded Sweatshirt', description: 'Fleece-lined pullover hoodie.' },
    ],
  },
  BOOK_STORE: {
    locationNames: ['Downtown Branch', 'Back Stockroom'],
    currency: 'USD',
    metadataGroups: [
      { name: 'Genre', options: ['Fiction', 'Non-fiction', 'Sci-Fi', 'Biography'] },
      { name: 'Format', options: ['Paperback', 'Hardcover', 'Ebook'] },
    ],
    products: [
      { sku: 'BK-001', name: 'The Long Horizon', description: 'A novel about distance and return.' },
      { sku: 'BK-002', name: 'Silent Circuits', description: 'A history of the early computing age.' },
      { sku: 'BK-003', name: 'A History of Tomorrow', description: 'Essays on speculative futures.' },
    ],
  },
  REPAIR_SHOP: {
    locationNames: ['Service Center', 'Parts Storage'],
    currency: 'USD',
    metadataGroups: [
      { name: 'Category', options: ['Electronics', 'Appliances', 'Bicycles'] },
      { name: 'Warranty', options: ['30 Days', '90 Days', '1 Year'] },
    ],
    products: [
      { sku: 'RPR-001', name: 'Screen Replacement Kit', description: 'Includes tools and adhesive.' },
      { sku: 'RPR-002', name: 'Battery Pack', description: 'Universal replacement battery.' },
      { sku: 'RPR-003', name: 'Tune-Up Service Kit', description: 'Standard maintenance parts bundle.' },
    ],
  },
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
    ],
  },
}

const ES_BLUEPRINTS: Record<BimePreset, PresetBlueprint> = {
  CLOTHING_STORE: {
    locationNames: ['Tienda Principal', 'Depósito Anexo'],
    currency: 'USD',
    metadataGroups: [
      { name: 'Talle', options: ['XS', 'S', 'M', 'L', 'XL'] },
      { name: 'Color', options: ['Negro', 'Blanco', 'Rojo', 'Azul'] },
    ],
    products: [
      { sku: 'TEE-001', name: 'Remera Clásica', description: 'Remera de algodón con cuello redondo.' },
      { sku: 'JNS-002', name: 'Jean Slim', description: 'Jean de tiro medio, corte ajustado.' },
      { sku: 'HOD-003', name: 'Buzo con Capucha', description: 'Buzo con capucha forrado en polar.' },
    ],
  },
  BOOK_STORE: {
    locationNames: ['Sucursal Centro', 'Depósito Trasero'],
    currency: 'USD',
    metadataGroups: [
      { name: 'Género', options: ['Ficción', 'No ficción', 'Ciencia ficción', 'Biografía'] },
      { name: 'Formato', options: ['Tapa blanda', 'Tapa dura', 'Libro electrónico'] },
    ],
    products: [
      { sku: 'BK-001', name: 'El Horizonte Lejano', description: 'Una novela sobre la distancia y el regreso.' },
      { sku: 'BK-002', name: 'Circuitos Silenciosos', description: 'Una historia de los primeros tiempos de la computación.' },
      { sku: 'BK-003', name: 'Una Historia del Mañana', description: 'Ensayos sobre futuros especulativos.' },
    ],
  },
  REPAIR_SHOP: {
    locationNames: ['Centro de Servicio', 'Depósito de Repuestos'],
    currency: 'USD',
    metadataGroups: [
      { name: 'Categoría', options: ['Electrónica', 'Electrodomésticos', 'Bicicletas'] },
      { name: 'Garantía', options: ['30 días', '90 días', '1 año'] },
    ],
    products: [
      { sku: 'RPR-001', name: 'Kit de Reemplazo de Pantalla', description: 'Incluye herramientas y adhesivo.' },
      { sku: 'RPR-002', name: 'Batería de Repuesto', description: 'Batería de reemplazo universal.' },
      { sku: 'RPR-003', name: 'Kit de Mantenimiento', description: 'Paquete estándar de piezas de mantenimiento.' },
    ],
  },
  STORAGE_WAREHOUSE: {
    locationNames: ['Centro de Distribución', 'Patio de Excedentes'],
    currency: 'USD',
    metadataGroups: [
      { name: 'Tipo de Pallet', options: ['Estándar', 'Europeo', 'Personalizado'] },
      { name: 'Manipuleo', options: ['Frágil', 'Estándar', 'Peligroso'] },
    ],
    products: [
      { sku: 'WHS-001', name: 'Rollo de Film Stretch', description: 'Film stretch, 500mm x 300m.' },
      { sku: 'WHS-002', name: 'Estantería de Acero', description: 'Estantería de 5 niveles sin tornillos.' },
      { sku: 'WHS-003', name: 'Set de Correas de Carga', description: 'Correas con trinquete, set de 4.' },
    ],
  },
}

const BLUEPRINTS_BY_LANG: Record<DemoLang, Record<BimePreset, PresetBlueprint>> = {
  en: EN_BLUEPRINTS,
  es: ES_BLUEPRINTS,
}

export function seedBimeCatalog(db: Db, orgId: string, preset: BimePreset, lang: DemoLang): void {
  const bp = BLUEPRINTS_BY_LANG[lang][preset]

  const locations: LocationResponse[] = bp.locationNames.map((name, i) => ({
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

  const metadata: ProductMetadataResponse[] = bp.metadataGroups.map(group => ({
    id: uid(),
    orgId,
    name: group.name,
    options: group.options.map(value => ({ id: uid(), metadataId: '', value, createdAt: nowIso() })),
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
        price: 19.99 + idx * 5 + i * 2,
        priceCurrency: bp.currency,
      }
      db.variants.push(variant)

      locations.forEach((location, locIdx) => {
        const quantity = Math.max(4, 42 - locIdx * 16 - i * 6 + idx * 2)

        const movement: StockMovementResponse = {
          id: uid(),
          orgId,
          productId,
          variantId,
          locationId: location.id,
          movementType: 'INBOUND',
          delta: quantity,
          referenceId: null,
          note: 'Initial stock',
          createdAt: nowIso(),
          createdBy: 'system',
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
  })
}
