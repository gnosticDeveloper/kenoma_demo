// Client-side reproduction of the Bime backend's SaleTicketDocumentService:
// a narrow (80 mm) thermal-receipt-style PDF for one completed sale. The demo
// has no server, so this renders the same layout in the browser — company name
// heading, caption, location / reference / date / time meta, a rule, priced
// lines, and a subtotal + "not a tax receipt" footer pinned to the bottom of
// the last page. Deliberately minimal; NOT a tax document.

export interface SaleTicketLine {
  description: string
  quantity: number
  unit: string
  unitPrice: number
  lineTotal: number
}

export interface SaleTicketData {
  companyName: string | null
  locationName: string | null
  locationCode: string | null
  reference: string | null
  saleId: string
  soldAt: string
  currency: string | null
  subtotal: number
  note: string | null
  lines: SaleTicketLine[]
}

// 80 mm roll minus a hair, and a fixed cut length, in PostScript points.
const PAGE_W = 226
const PAGE_H = 340
const MARGIN = 14
const BODY_W = PAGE_W - 2 * MARGIN

const SIZE = { title: 11, caption: 7.5, meta: 7.5, item: 8, foot: 6.5 }
const GRAY = '0.55 0.55 0.55'

type Lang = 'en' | 'es'

interface Labels {
  receipt: string; location: string; reference: string
  date: string; time: string; subtotal: string; disclaimer: string
}

function labels(lang: Lang): Labels {
  if (lang === 'es') {
    return {
      receipt: 'Recibo de venta', location: 'Ubicación', reference: 'Referencia',
      date: 'Fecha', time: 'Hora', subtotal: 'Subtotal',
      disclaimer: 'No es un comprobante fiscal. Impreso el %s.',
    }
  }
  return {
    receipt: 'Sale receipt', location: 'Location', reference: 'Reference',
    date: 'Date', time: 'Time', subtotal: 'Subtotal',
    disclaimer: 'This is not a tax receipt. Printed %s.',
  }
}

// ── money ────────────────────────────────────────────────────────────────────
// Mirrors the backend: format with a locale that uses the currency ($, €, £, ¥)
// rather than the 3-letter code, and drop the gap between symbol and digits.
const CURRENCY_LOCALE: Record<string, string> = {
  USD: 'en-US', ARS: 'es-AR', EUR: 'de-DE', GBP: 'en-GB', JPY: 'ja-JP',
  BRL: 'pt-BR', MXN: 'es-MX', CLP: 'es-CL', COP: 'es-CO', PEN: 'es-PE',
  UYU: 'es-UY', CAD: 'en-CA', AUD: 'en-AU', CHF: 'de-CH', CNY: 'zh-CN', INR: 'en-IN',
}

function money(amount: number | null, currency: string | null, lang: Lang): string {
  if (amount == null) return '-'
  if (!currency) {
    return new Intl.NumberFormat(lang, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)
  }
  const code = currency.trim().toUpperCase()
  try {
    const loc = CURRENCY_LOCALE[code] ?? lang
    const s = new Intl.NumberFormat(loc, { style: 'currency', currency: code }).format(amount)
    return s.replace(/([^\s\d])[\s  ]+(\d)/, '$1$2')
  } catch {
    return code + ' ' + new Intl.NumberFormat(lang, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)
  }
}

function trimQty(n: number): string {
  return String(Math.round(n * 1000) / 1000)
}

// ── Helvetica AFM widths (1000-unit em), WinAnsi byte-indexed ────────────────
const HELV_ASCII = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
]
const HELVB_ASCII = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
]
const HIGH_OVERRIDE: Record<number, number> = {
  0x80: 556, 0x85: 1000, 0x91: 222, 0x92: 222, 0x93: 333, 0x94: 333,
  0x95: 350, 0x96: 556, 0x97: 1000, 0xa0: 278, 0xa3: 556, 0xa5: 556, 0xd7: 584,
}

// U+2000-range punctuation -> WinAnsi byte.
const WINANSI_SPECIAL: Record<number, number> = {
  0x20ac: 0x80, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94,
  0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x2026: 0x85, 0x2122: 0x99,
}

function winansiByte(ch: string): number {
  const c = ch.codePointAt(0) ?? 0x3f
  if (c >= 0x20 && c <= 0x7e) return c
  if (WINANSI_SPECIAL[c] != null) return WINANSI_SPECIAL[c]
  if (c >= 0xa0 && c <= 0xff) return c
  const de = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '')
  const d = de.codePointAt(0) ?? 0x3f
  return d >= 0x20 && d <= 0x7e ? d : 0x3f
}

function charWidth(ch: string, bold: boolean): number {
  const b = winansiByte(ch)
  if (b >= 32 && b <= 126) return (bold ? HELVB_ASCII : HELV_ASCII)[b - 32]
  if (HIGH_OVERRIDE[b] != null) return HIGH_OVERRIDE[b]
  return bold ? 556 : 556
}

function textWidth(s: string, size: number, bold: boolean): number {
  let w = 0
  for (const ch of s) w += charWidth(ch, bold)
  return (w / 1000) * size
}

function wrapText(s: string, size: number, bold: boolean, maxW: number): string[] {
  const words = s.split(/\s+/).filter(Boolean)
  if (words.length === 0) return ['']
  const out: string[] = []
  let cur = ''
  for (const word of words) {
    const trial = cur ? cur + ' ' + word : word
    if (textWidth(trial, size, bold) <= maxW || !cur) {
      cur = trial
    } else {
      out.push(cur)
      cur = word
    }
  }
  if (cur) out.push(cur)
  return out
}

function escapePdfText(s: string): string {
  let out = ''
  for (const ch of s) {
    if (ch === '(' || ch === ')' || ch === '\\') { out += '\\' + ch; continue }
    const c = ch.codePointAt(0) ?? 0x3f
    if (c >= 0x20 && c <= 0x7e) { out += ch; continue }
    out += '\\' + winansiByte(ch).toString(8).padStart(3, '0')
  }
  return out
}

// ── content-stream drawing ──────────────────────────────────────────────────
const FONT_ID = { reg: 'F1', bold: 'F2', ital: 'F3' } as const
type FontKey = keyof typeof FONT_ID

interface Cursor { pages: string[][]; i: number; y: number }

function newCursor(): Cursor {
  return { pages: [[]], i: 0, y: PAGE_H - MARGIN }
}

function pageBreak(c: Cursor): void {
  c.pages.push([])
  c.i += 1
  c.y = PAGE_H - MARGIN
}

function ensureSpace(c: Cursor, needed: number): void {
  if (c.y - needed < MARGIN) pageBreak(c)
}

function drawText(c: Cursor, x: number, baseline: number, s: string, size: number, font: FontKey): void {
  c.pages[c.i].push(
    `BT /${FONT_ID[font]} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${baseline.toFixed(2)} Tm (${escapePdfText(s)}) Tj ET`,
  )
}

function drawCentered(c: Cursor, baseline: number, s: string, size: number, font: FontKey): void {
  const bold = font === 'bold'
  const x = MARGIN + (BODY_W - textWidth(s, size, bold)) / 2
  drawText(c, Math.max(MARGIN, x), baseline, s, size, font)
}

function drawRight(c: Cursor, xRight: number, baseline: number, s: string, size: number, font: FontKey): void {
  const bold = font === 'bold'
  drawText(c, xRight - textWidth(s, size, bold), baseline, s, size, font)
}

function drawRule(c: Cursor, y: number): void {
  c.pages[c.i].push(`q ${GRAY} RG 0.5 w ${MARGIN} ${y.toFixed(2)} m ${(PAGE_W - MARGIN)} ${y.toFixed(2)} l S Q`)
}

// ── main ────────────────────────────────────────────────────────────────────
export function renderSaleTicket(data: SaleTicketData, lang: Lang = 'en'): Blob {
  const text = labels(lang)
  const c = newCursor()

  const heading = data.companyName && data.companyName.trim()
    ? data.companyName.trim()
    : text.receipt.toUpperCase()

  // Title + caption, centered.
  for (const line of wrapText(heading, SIZE.title, true, BODY_W)) {
    c.y -= SIZE.title + 1
    drawCentered(c, c.y, line, SIZE.title, 'bold')
  }
  c.y -= SIZE.caption + 2
  drawCentered(c, c.y, text.receipt, SIZE.caption, 'reg')
  c.y -= 8

  // Meta lines.
  const meta = (label: string, value: string) => {
    c.y -= SIZE.meta + 2
    drawText(c, MARGIN, c.y, `${label}: ${value}`, SIZE.meta, 'reg')
  }
  const locationLine = data.locationName && data.locationName.trim()
    ? (data.locationCode && data.locationCode.trim()
        ? `${data.locationName.trim()} (${data.locationCode.trim()})`
        : data.locationName.trim())
    : null
  if (locationLine) meta(text.location, locationLine)
  const ref = data.reference && data.reference.trim()
    ? data.reference.trim()
    : (data.saleId ? data.saleId.slice(0, 8) : '-')
  meta(text.reference, ref)
  const when = data.soldAt ? new Date(data.soldAt) : null
  const pad = (n: number) => String(n).padStart(2, '0')
  meta(text.date, when ? `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` : '-')
  meta(text.time, when ? `${pad(when.getHours())}:${pad(when.getMinutes())}` : '-')

  c.y -= 5
  drawRule(c, c.y)
  c.y -= 6

  // ── closing block, measured up front so it can be pinned to the last page ──
  const disclaimerText = text.disclaimer.replace('%s', (() => {
    const now = new Date()
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  })())
  const noteLines = data.note && data.note.trim()
    ? wrapText(data.note.trim(), SIZE.meta, false, BODY_W)
    : []
  const disclaimerLines = wrapText(disclaimerText, SIZE.foot, false, BODY_W)
  const closingHeight =
    6 +                                   // rule + gap
    (SIZE.item + 4) +                      // subtotal row
    (noteLines.length ? noteLines.length * (SIZE.meta + 2) + 4 : 0) +
    disclaimerLines.length * (SIZE.foot + 2) + 6

  // Priced lines.
  const priceX = PAGE_W - MARGIN
  for (const line of data.lines) {
    const descLines = wrapText(line.description || '', SIZE.item, false, BODY_W)
    const qtyLabel = `${trimQty(line.quantity)}${line.unit ? ' ' + line.unit.trim() : ''} × ${money(line.unitPrice, data.currency, lang)}`
    const rowH = descLines.length * (SIZE.item + 2) + (SIZE.meta + 3) + 3
    ensureSpace(c, rowH + closingHeight + 4)
    for (const dl of descLines) {
      c.y -= SIZE.item + 2
      drawText(c, MARGIN, c.y, dl, SIZE.item, 'reg')
    }
    c.y -= SIZE.meta + 3
    drawText(c, MARGIN, c.y, qtyLabel, SIZE.meta, 'reg')
    drawRight(c, priceX, c.y, money(line.lineTotal, data.currency, lang), SIZE.item, 'reg')
    c.y -= 3
  }

  // Pin the closing block to the bottom of the current (or a fresh) page.
  if (c.y - closingHeight < MARGIN) pageBreak(c)
  let cy = MARGIN + closingHeight
  drawRule(c, cy)
  cy -= SIZE.item + 4
  drawText(c, MARGIN, cy, text.subtotal, SIZE.item, 'bold')
  drawRight(c, priceX, cy, money(data.subtotal, data.currency, lang), SIZE.item, 'bold')
  if (noteLines.length) {
    cy -= 4
    for (const nl of noteLines) {
      cy -= SIZE.meta + 2
      drawText(c, MARGIN, cy, nl, SIZE.meta, 'reg')
    }
  }
  cy -= 6
  for (const dl of disclaimerLines) {
    cy -= SIZE.foot + 2
    drawCentered(c, cy, dl, SIZE.foot, 'ital')
  }

  return assemble(c.pages)
}

// ── PDF object assembly ─────────────────────────────────────────────────────
function assemble(pages: string[][]): Blob {
  const fontObjs: Record<FontKey, number> = { reg: 3, bold: 4, ital: 5 }
  const objs: string[] = []
  objs[1] = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'
  objs[3] = '3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n'
  objs[4] = '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n'
  objs[5] = '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>\nendobj\n'

  let next = 6
  const pageNums: number[] = []
  for (const frags of pages) {
    const pageNum = next++
    const contentNum = next++
    pageNums.push(pageNum)
    const stream = frags.join('\n') + '\n'
    objs[pageNum] =
      `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 ${fontObjs.reg} 0 R /F2 ${fontObjs.bold} 0 R /F3 ${fontObjs.ital} 0 R >> >> ` +
      `/Contents ${contentNum} 0 R >>\nendobj\n`
    objs[contentNum] = `${contentNum} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\n`
  }
  objs[2] =
    `2 0 obj\n<< /Type /Pages /Kids [${pageNums.map(n => `${n} 0 R`).join(' ')}] /Count ${pageNums.length} >>\nendobj\n`

  const total = next - 1
  const offsets: number[] = new Array(total + 1).fill(0)
  let pdf = '%PDF-1.4\n'
  for (let i = 1; i <= total; i++) {
    offsets[i] = pdf.length
    pdf += objs[i]
  }
  const xrefStart = pdf.length
  pdf += `xref\n0 ${total + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= total; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`

  // The stream text is ASCII (non-WinAnsi bytes are octal-escaped), so 1 char == 1 byte.
  const bytes = new Uint8Array(pdf.length)
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff
  return new Blob([bytes], { type: 'application/pdf' })
}
