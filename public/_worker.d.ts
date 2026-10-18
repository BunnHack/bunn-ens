export function handleWmc(request: Request, env: { WMC_AUTH?: string }, ctx: { waitUntil(promise: Promise<unknown>): void }, url: URL, digest?: (bytes: Uint8Array) => Promise<ArrayBuffer | Uint8Array>): Promise<Response>
export function handleModelTracks(request: Request, ctx: { waitUntil(promise: Promise<unknown>): void }, url: URL): Promise<Response>
export function handleCurrentStorms(request: Request, ctx: { waitUntil(promise: Promise<unknown>): void }, url: URL): Promise<Response>
export function handleIntensityAids(request: Request, ctx: { waitUntil(promise: Promise<unknown>): void }, url: URL): Promise<Response>
