export function exportDimensions(viewBox: string | null): { width: number; height: number } {
  const values = viewBox?.trim().split(/[\s,]+/).map(Number)
  const ratio = values?.length === 4 && values.every(Number.isFinite) && values[2]! > 0 && values[3]! > 0 ? values[3]! / values[2]! : 1580 / 2000
  const height = Math.min(8000, Math.max(1, Math.round(2000 * ratio)))
  return { width: 2000 * ratio > 8000 ? Math.max(1, Math.round(height / ratio)) : 2000, height }
}
export function serializeChart(svg: SVGSVGElement): string {
  const copy = svg.cloneNode(true) as SVGSVGElement
  const size = exportDimensions(svg.getAttribute('viewBox'))
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  copy.setAttribute('width', String(size.width))
  copy.setAttribute('height', String(size.height))
  const style = copy.getAttribute('style') ?? ''
  copy.setAttribute('style', `${style}${style && !style.endsWith(';') ? ';' : ''}font-family:Arial,sans-serif`)
  return copy.outerHTML
}

export async function chartPng(svg: string): Promise<string> {
  const image = new Image()
  const source = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('Unable to render chart image; use Download SVG instead.'))
      image.src = source
    })
    const canvas = document.createElement('canvas')
    const root = svg.match(/<svg\b[^>]*>/)?.[0] ?? ''
    canvas.width = Number(root.match(/\bwidth="(\d+)"/)?.[1] ?? 2000)
    canvas.height = Number(root.match(/\bheight="(\d+)"/)?.[1] ?? 1580)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('PNG export is unavailable; use Download SVG instead.')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const png = canvas.toDataURL('image/png')
    if (!png.startsWith('data:image/png;')) throw new Error('PNG export failed; use Download SVG instead.')
    return png
  } finally { URL.revokeObjectURL(source) }
}
