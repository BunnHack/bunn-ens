export function serializeChart(svg: SVGSVGElement): string {
  const copy = svg.cloneNode(true) as SVGSVGElement
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  copy.setAttribute('width', '2000')
  copy.setAttribute('height', '1580')
  copy.setAttribute('style', 'font-family:Arial,sans-serif')
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
    canvas.width = 2000; canvas.height = 1580
    const context = canvas.getContext('2d')
    if (!context) throw new Error('PNG export is unavailable; use Download SVG instead.')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const png = canvas.toDataURL('image/png')
    if (!png.startsWith('data:image/png;')) throw new Error('PNG export failed; use Download SVG instead.')
    return png
  } finally { URL.revokeObjectURL(source) }
}
