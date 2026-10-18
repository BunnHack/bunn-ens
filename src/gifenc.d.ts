declare module 'gifenc' {
  export function quantize(data: Uint8ClampedArray, colors: number, options?: { format: string }): number[][]
  export function applyPalette(data: Uint8ClampedArray, palette: number[][], format?: string): Uint8Array
  export function GIFEncoder(): { writeFrame(data: Uint8Array, width: number, height: number, options: { palette: number[][]; delay: number; repeat: number; dispose: number }): void; finish(): void; bytes(): Uint8Array }
  const module: { GIFEncoder: typeof GIFEncoder; quantize: typeof quantize; applyPalette: typeof applyPalette }
  export default module
}
