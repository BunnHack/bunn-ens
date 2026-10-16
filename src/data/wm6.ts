export type Basin = 'AL' | 'EP' | 'CP' | 'WP' | 'NI' | 'SI' | 'AU' | 'SP'
export type Wm6Point = { valid_at: string; forecast_hour: number; latitude: number; longitude: number; max_wind_kt?: number | null; min_mslp_hpa?: number | null; storm_type?: string; contributing_members_count?: number }
export type Wm6MemberPath = { member: number; path: Wm6Point[] }
export type Wm6Landfall = { valid_at: string; latitude: number; longitude: number; max_wind_kt?: number | null; min_mslp_hpa?: number | null; storm_type?: string; ensemble_member?: number }
export type Wm6Cyclone = {
  tropical_cyclone_id: string
  storm_name: string | null
  basins: Basin[]
  genesis?: { latitude: number; longitude: number } | null
  start_time: string
  end_time: string
  max_wind_kt?: number | null
  min_mslp_hpa?: number | null
  path?: Wm6Point[]
  mean_path?: Wm6Point[]
  landfalls?: Wm6Landfall[]
  members_path?: Wm6MemberPath[]
  matched_members?: number
  ens_size?: number
}
export type Wm6CycloneDetail = Wm6Cyclone & {
  initialization_time: string
  forecast_zero: string
  mean_path: Wm6Point[]
}
export type Wm6Response = { initialization_time: string; forecast_zero: string; tropical_cyclones: Record<string, Wm6Cyclone>; total: number }
export type Wm6GeoJson = { type: 'FeatureCollection'; features: Array<{ type: 'Feature'; geometry: { type: string; coordinates: unknown }; properties?: Record<string, unknown> }> }
export type Wm6Params = { initialization_time?: string; basin?: Basin; include_unofficial_ids?: boolean; include_details?: boolean; format?: 'json' | 'geojson' }

async function requestJson(url: string, signal: AbortSignal | undefined, fetcher: typeof fetch): Promise<unknown> {
  const response = await fetcher(url, { signal })
  if (!response.ok) throw new Error(`WM-6 returned HTTP ${response.status}`)
  return response.json()
}
export async function loadWm6(params: Wm6Params = {}, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<Wm6Response | Wm6GeoJson> {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, String(value))
  const result = await requestJson(`/api/wm6?${query}`, signal, fetcher) as Wm6Response | Wm6GeoJson
  if (params.format === 'geojson') {
    if (!('type' in result) || result.type !== 'FeatureCollection' || !Array.isArray(result.features)) throw new Error('Invalid WM-6 GeoJSON')
  } else if (!('tropical_cyclones' in result) || !result.tropical_cyclones || !Number.isFinite(Date.parse(result.initialization_time))) throw new Error('Invalid WM-6 cyclone list')
  return result
}
export async function loadWm6Cyclone(id: string, params: { initialization_time: string; include_members?: boolean; include_cones?: boolean }, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<Wm6CycloneDetail> {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, String(value))
  const result = await requestJson(`/api/wm6/${encodeURIComponent(id)}?${query}`, signal, fetcher) as Wm6CycloneDetail
  if (result.tropical_cyclone_id !== id || !Array.isArray(result.mean_path) || (params.include_members && !Array.isArray(result.members_path))) throw new Error('Invalid WM-6 cyclone detail')
  if (params.initialization_time !== 'latest' && Date.parse(result.initialization_time) !== Date.parse(params.initialization_time)) throw new Error('WM-6 detail initialization does not match selected run')
  return result
}
