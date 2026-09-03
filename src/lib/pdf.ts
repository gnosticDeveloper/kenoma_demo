// Minimal, dependency-free PDF writer for the demo's stand-in "printed"
// documents (sale tickets, barcode label sheets). A real deployment gets
// proper server-rendered PDFs; this just produces a valid, openable file
// of monospaced text so the browser's PDF viewer has something to show.

const FONT_SIZE = 10
const LEADING = 13
const LEFT = 40
const TOP = 752
const BOTTOM = 48
const LINES_PER_PAGE = Math.max(1, Math.floor((TOP - BOTTOM) / LEADING))
const MAX_CHARS = 92

const CHAR_MAP: Record<string, string> = {
  '×': 'x', '–': '-', '—': '-', '‘': "'", '’': "'",
  '“': '"', '”': '"', '€': 'EUR', '£': 'GBP', '¥': 'JPY',
  '·': '-', '…': '...', '−': '-',
}

function deburr(ch: string): string {
  const n = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '')
  return /^[\x20-\x7e]+$/.test(n) ? n : '?'
}

// PDF base-14 Courier only reliably renders ASCII; fold everything else down
// so the document stays single-byte (keeps xref offsets = string indices).
function toAscii(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, ch => CHAR_MAP[ch] ?? deburr(ch))
}

function wrap(line: string): string[] {
  if (line.length <= MAX_CHARS) return [line]
  const out: string[] = []
  let rest = line
  while (rest.length > MAX_CHARS) {
    let cut = rest.lastIndexOf(' ', MAX_CHARS)
    if (cut < MAX_CHARS * 0.5) cut = MAX_CHARS
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^ /, '')
  }
  if (rest) out.push(rest)
  return out
}

function escapePdf(s: string): string {
  return s.replace(/([\\()])/g, '\\$1')
}

/** Render an array of text lines as a valid multi-page PDF Blob. */
export function buildTextPdf(rawLines: string[]): Blob {
  const lines = rawLines.flatMap(l => wrap(toAscii(l)))
  const pages: string[][] = []
  for (let i = 0; i < lines.length; i += LINES_PER_PAGE) {
    pages.push(lines.slice(i, i + LINES_PER_PAGE))
  }
  if (pages.length === 0) pages.push([''])

  const FONT_OBJ = 3
  const objs: string[] = []
  const pageObjNums: number[] = []
  const contentStreams: { num: number; body: string }[] = []
  let nextObj = 4

  for (const pageLines of pages) {
    const pageNum = nextObj++
    const contentNum = nextObj++
    pageObjNums.push(pageNum)
    const text = pageLines
      .map((l, idx) => `${idx === 0 ? '' : 'T* '}(${escapePdf(l)}) Tj`)
      .join('\n')
    const body = `BT /F1 ${FONT_SIZE} Tf ${LEFT} ${TOP} Td ${LEADING} TL\n${text}\nET`
    contentStreams.push({ num: contentNum, body })
    objs[pageNum] =
      `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${FONT_OBJ} 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`
  }
  for (const cs of contentStreams) {
    objs[cs.num] = `${cs.num} 0 obj\n<< /Length ${cs.body.length} >>\nstream\n${cs.body}\nendstream\nendobj\n`
  }

  objs[1] = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`
  objs[2] =
    `2 0 obj\n<< /Type /Pages /Kids [${pageObjNums.map(n => `${n} 0 R`).join(' ')}] ` +
    `/Count ${pageObjNums.length} >>\nendobj\n`
  objs[3] = `3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>\nendobj\n`

  const total = nextObj - 1
  const offsets: number[] = new Array(total + 1).fill(0)
  let pdf = '%PDF-1.4\n'
  for (let i = 1; i <= total; i++) {
    offsets[i] = pdf.length
    pdf += objs[i]
  }
  const xrefStart = pdf.length
  pdf += `xref\n0 ${total + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= total; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`

  return new Blob([pdf], { type: 'application/pdf' })
}
