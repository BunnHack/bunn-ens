#!/usr/bin/env python3
"""Generate real WM-6 ensemble-mean charts; credentials and native grids stay private."""
import argparse
import base64
import tempfile
from urllib.parse import urlparse
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
import io
import gzip
import json
import os
from pathlib import Path
import shutil
import time

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.collections import LineCollection
from matplotlib.colors import BoundaryNorm, ListedColormap
import numpy as np
import requests

ROOT = Path(__file__).resolve().parents[1]
API = 'https://api.windbornesystems.com/forecasts/v1/wm-6'
G = 9.80665
REGIONS = [
    {'id': 'east-asia', 'label': 'East Asia', 'bounds': [75, 155, 5, 60]},
    {'id': 'west-pacific', 'label': 'West Pacific', 'bounds': [100, 180, 0, 55]},
    {'id': 'north-america', 'label': 'North America', 'bounds': [-140, -55, 10, 65]},
]
PRODUCTS = [
    {'id': 'precip', 'label': '6h Precip / MSLP / Thickness', 'group': 'Precip/Moisture'},
    {'id': 'wind', 'label': '10m Wind / MSLP', 'group': 'Lower Dynamics'},
    {'id': 'upper', 'label': '500 hPa Height / Temperature', 'group': 'Upper Dynamics'},
    {'id': 'temperature', 'label': '2m Temperature', 'group': 'Thermodynamics'},
    {'id': 'dewpoint', 'label': '2m Dewpoint', 'group': 'Thermodynamics'},
    {'id': 'cape', 'label': 'CAPE', 'group': 'Thermodynamics'},
    {'id': 'tcwv', 'label': 'Total Column Water Vapour', 'group': 'Precip/Moisture'},
    {'id': 'temperature850', 'label': '850 hPa Temperature', 'group': 'Thermodynamics'},
    {'id': 'wind250', 'label': '250 hPa Wind Speed', 'group': 'Upper Dynamics'},
]
FIELDS = {
    'pressure_msl': ('pressure_msl', None),
    'z500': ('geopotential', 500), 'z1000': ('geopotential', 1000),
    't500': ('temperature', 500), 'temperature_2m': ('temperature_2m', None),
    'wind_speed_10m': ('wind_speed_10m', None),
    'precip': ('total_precipitation_3h', None),
    'dewpoint': ('dewpoint_2m', None), 'cape': ('cape', None),
    'tcwv': ('total_column_water_vapour', None),
    't850': ('temperature', 850), 'wind250': ('wind_speed', 250),
}
REQUIRED = {'precip': ['pressure_msl', 'z500', 'z1000', 'precip', 'previous_precip'],
            'wind': ['wind_speed_10m', 'pressure_msl'], 'upper': ['z500', 't500'],
            'temperature': ['temperature_2m'], 'dewpoint': ['dewpoint'], 'cape': ['cape'],
            'tcwv': ['tcwv'], 'temperature850': ['t850'], 'wind250': ['wind250']}


def utc(value):
    result = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('Timestamp must include timezone')
    return result.astimezone(timezone.utc)


def iso(value):
    return value.astimezone(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def run_id(value):
    return utc(value).strftime('%Y%m%dT%H%MZ')


def verify_metadata(attrs, run, hour):
    def scalar(value):
        if isinstance(value, bytes):
            return value.decode()
        if isinstance(value, np.ndarray):
            return value.item()
        return value
    if scalar(attrs.get('model')) not in ('wm-6', 'WM 6 Global'):
        raise ValueError('Unexpected native model')
    for key in ['initialization_time', 'forecast_zero']:
        if utc(scalar(attrs[key])) != utc(run[key]):
            raise ValueError('NetCDF run/forecast_zero mismatch')
    if int(scalar(attrs['forecast_hour'])) != hour:
        raise ValueError('NetCDF forecast-hour mismatch')


def convert_field(values, unit, kind):
    """Only conversions justified by native NetCDF units; unknown units fail closed."""
    if isinstance(unit, bytes):
        unit = unit.decode()
    unit = str(unit).strip().lower().replace(' ', '').replace('**', '^')
    acceptable = {
        'pressure_msl': {'pa'}, 'z500': {'m2s-2', 'm^2s^-2', 'm2/s2'},
        'z1000': {'m2s-2', 'm^2s^-2', 'm2/s2'}, 't500': {'k'},
        'temperature_2m': {'k'}, 'wind_speed_10m': {'ms-1', 'm/s', 'ms^-1'},
        'precip': {'mm'}, 'previous_precip': {'mm'}, 'dewpoint': {'k'}, 't850': {'k'},
        'cape': {'jkg-1', 'jkg^-1', 'j/kg'},
        'tcwv': {'kgm-2', 'kgm^-2', 'kg/m2', 'kg/m^2'},
        'wind250': {'ms-1', 'm/s', 'ms^-1'},
    }
    if unit not in acceptable[kind]:
        raise ValueError(f'Unsupported units for {kind}')
    values = np.asarray(values, dtype=np.float64)
    if kind == 'pressure_msl':
        return values / 100
    if kind in ('z500', 'z1000'):
        return values / G / 10  # geopotential -> geopotential height in decametres
    if kind in ('t500', 'temperature_2m', 'dewpoint', 't850'):
        return values - 273.15
    if kind in ('wind_speed_10m', 'wind250'):
        return values * 3600 / 1852  # native m/s -> kt; unrelated to cyclone max_wind_kt
    return values


def precipitation_rate(current, previous):
    """Two adjoining, same-run 3h accumulations / 6h, never a made-up rain/snow split."""
    return (np.asarray(current) + np.asarray(previous)) / 6


_next_api_request = 0
API_INTERVAL = float(os.environ.get('WM_API_INTERVAL_SECONDS', '15'))


def request(session, path, params=None):
    global _next_api_request
    for attempt in range(5):
        try:
            now = time.monotonic()
            delay = max(0, _next_api_request - now)
            _next_api_request = max(now, _next_api_request) + API_INTERVAL
            if delay:
                time.sleep(delay)
            response = session.get(API + path, params=params, timeout=(20, 120))
            if response.status_code == 429 and len(response.content) <= 4096:
                try:
                    failure = response.json()
                except ValueError:
                    failure = {}
                if isinstance(failure, dict) and failure.get('error') == 'Quota exceeded' and 'total requests' in str(failure.get('message', '')):
                    response.close()
                    raise RuntimeError('WM-6 account total request quota exhausted; restore authorized quota/key before generation. Existing publication is unchanged.')
            if response.status_code in (429, 500, 502, 503, 504) and attempt < 4:
                try:
                    delay = float(response.headers.get('Retry-After', '30' if response.status_code == 429 else '5'))
                except ValueError:
                    delay = 30
                response.close()
                time.sleep(min(120, max(15 if response.status_code == 429 else 1, delay) * (attempt + 1)))
                continue
            if not response.ok:
                raise RuntimeError(f'WM-6 HTTP {response.status_code}')
            return response
        except requests.RequestException:
            if attempt == 4:
                raise RuntimeError('WM-6 network request failed') from None
            time.sleep(5 * (attempt + 1))
    raise RuntimeError('WM-6 request failed')


def download_field(session, run, hour, key):
    import h5py  # Ubuntu Actions wheel; no workerd/Cartopy or online basemap required
    variable, level = FIELDS['precip' if key == 'previous_precip' else key]
    params = {'variable': variable, 'format': 'netcdf', 'initialization_time': run['initialization_time'], 'forecast_hour': hour}
    if level is not None:
        params['level'] = level
    with request(session, '/gridded', params) as response:
        data = response.content
    if len(data) > 64 * 1024 * 1024:
        raise ValueError('Unexpectedly large NetCDF')
    with h5py.File(io.BytesIO(data), 'r') as dataset:
        verify_metadata(dataset.attrs, run, hour)
        name = f'{variable}_{level}' if level is not None else variable
        field = dataset[name]
        lat = dataset['latitude'][:].astype(float)
        lon = dataset['longitude'][:].astype(float)
        values = field[:]
        if values.shape != (len(lat), len(lon)) or len(lat) < 2 or len(lon) < 2:
            raise ValueError('Unexpected grid dimensions/statistic')
        return lat, lon, convert_field(values, field.attrs['units'], key)


def archive_part(url, part):
    """Read only advertised Zarr payload bytes; never forward the provider API key."""
    if 'inline' in part:
        return base64.b64decode(part['inline'], validate=True)
    start, end = part['range']
    if not isinstance(start, int) or not isinstance(end, int) or start < 0 or not 0 <= end - start < 64 * 1024 * 1024:
        raise ValueError('Invalid archive byte range')
    for attempt in range(4):
        try:
            with requests.get(url, headers={'Range': f'bytes={start}-{end}'}, stream=True, timeout=(20, 120)) as response:
                if response.status_code != 206 or not response.headers.get('Content-Range', '').startswith(f'bytes {start}-{end}/'):
                    raise ValueError('Archive server did not honor the byte range')
                data = b''.join(response.iter_content(65536))
            if len(data) != end - start + 1:
                raise ValueError('Incomplete archive byte range')
            return data
        except (requests.RequestException, ValueError):
            if attempt == 3:
                raise RuntimeError('Archive byte-range download failed') from None
            time.sleep(2 * (attempt + 1))


def download_archive_fields(session, run, hour, keys):
    """One authenticated locator per hour; fetch only required ensemble-mean Zarr bytes."""
    import zarr
    names = {}
    for key in keys:
        variable, level = FIELDS['precip' if key == 'previous_precip' else key]
        names[key] = f'{variable}_{level}' if level is not None else variable
    params = {'variable': 'all' if len(keys) > 1 else next(iter(names.values())), 'format': 'zarr', 'as_url': 'true',
              'initialization_time': run['initialization_time'], 'forecast_hour': hour}
    with request(session, '/gridded', params) as response:
        locator = response.json()
    url = locator['url']
    parsed = urlparse(url)
    if parsed.scheme != 'https' or not parsed.hostname or not parsed.hostname.endswith(('.r2.cloudflarestorage.com', '.amazonaws.com', '.windbornesystems.com')):
        raise ValueError('Unexpected archive origin')
    prefixes = ['latitude/', 'longitude/'] + [f'ensemble_mean/{name}/' for name in names.values()]
    parts = [part for part in locator['parts'] if part['path'] in ('zarr.json', 'ensemble_mean/zarr.json') or any(part['path'].startswith(prefix) for prefix in prefixes)]
    with tempfile.TemporaryDirectory(prefix='wm6-native-') as directory:
        def fetch_part(part):
            relative = Path(part['path'])
            if relative.is_absolute() or '..' in relative.parts:
                raise ValueError('Invalid archive path')
            destination = Path(directory) / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(archive_part(url, part))
        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(fetch_part, parts))
        group = zarr.open_group(directory, mode='r')
        verify_metadata(dict(group.attrs), run, hour)
        def native_array(name):
            array = group[name]
            # Zarr fill_value=0 is not evidence for an unpublished/missing chunk.
            for index in np.ndindex(tuple((n+c-1)//c for n, c in zip(array.shape, array.chunks))):
                chunk = Path(directory) / name / 'c'
                for coordinate in index:
                    chunk = chunk / str(coordinate)
                if not chunk.is_file() or not chunk.stat().st_size:
                    raise ValueError('Native chunk missing; refusing implicit zero fill')
            return array
        lat, lon = np.asarray(native_array('latitude')[:], dtype=float), np.asarray(native_array('longitude')[:], dtype=float)
        result = {}
        for key, name in names.items():
            try:
                array = native_array(f'ensemble_mean/{name}')
                if array.attrs.get('product_type') != 'ensemble_mean' or array.shape != (len(lat), len(lon)):
                    raise ValueError('Unexpected archive grid/statistic')
                values = convert_field(array[:], array.attrs['units'], key)
                if not np.isfinite(values).any():
                    raise ValueError('Archive contains no valid field values')
                result[key] = lat, lon, values
            except (KeyError, ValueError):
                print(f'Native field {key} unavailable or invalid; no fill/substitute field used.', flush=True)
        return result


def regional_grid(field, region):
    lat, lon, values = field
    west, east, south, north = region['bounds']
    lon = ((lon - west) % 360) + west
    yi = np.flatnonzero((lat >= south) & (lat <= north))
    xi = np.flatnonzero((lon >= west) & (lon <= east))
    yi, xi = yi[np.argsort(lat[yi])], xi[np.argsort(lon[xi])]
    if len(yi) < 2 or len(xi) < 2:
        raise ValueError('No regional grid')
    return lon[xi], lat[yi], np.ma.masked_invalid(values[np.ix_(yi, xi)])


@lru_cache(maxsize=1)
def geography():
    data = json.loads((ROOT / 'src/data/fine-map.json').read_text())
    def decode(path):
        points, previous, cursor = [], [0, 0], 0
        while cursor < len(path):
            for axis in range(2):
                value, shift, byte = 0, 0, 32
                while byte >= 32:
                    byte = ord(path[cursor]) - 63
                    cursor += 1
                    value |= (byte & 31) << shift
                    shift += 5
                previous[axis] += ~(value >> 1) if value & 1 else value >> 1
            points.append([previous[0] / 10000, previous[1] / 10000])
        return np.array(points)
    return {kind: [(line['bounds'], decode(line['path'])) for line in data[kind]] for kind in ['land', 'borders']}


def add_geography(ax, region):
    west, east, south, north = region['bounds']
    for kind, color, width in [('land', '#30383d', .55), ('borders', '#677078', .35)]:
        paths = []
        for (left, bottom, right, top), points in geography()[kind]:
            if top < south or bottom > north:
                continue
            for copy in range(int(np.ceil((west - right) / 360)), int(np.floor((east - left) / 360)) + 1):
                paths.append(points + [copy * 360, 0])
        ax.add_collection(LineCollection(paths, colors=color, linewidths=width, zorder=5))


def contour(ax, x, y, values, levels, color, dashed=False):
    if values.count() == 0 or np.ma.max(values) == np.ma.min(values):
        return
    levels = [level for level in levels if np.ma.min(values) < level < np.ma.max(values)]
    if not levels:
        return
    lines = ax.contour(x, y, values, levels=levels, colors=color, linewidths=.65, linestyles='--' if dashed else '-', zorder=4)
    ax.clabel(lines, fontsize=6.5, fmt='%d', inline=True, inline_spacing=2)


def pressure_centers(x, y, pressure, radius_degrees=2.5, prominence_hpa=.5, separation_km=600):
    """Closed, interior local extrema of the actual ensemble-mean MSLP, not TC centres."""
    values = np.asarray(np.ma.filled(pressure, np.nan), dtype=float)
    if len(x) < 3 or len(y) < 3:
        return []
    rx = max(1, int(np.ceil(radius_degrees / np.median(np.abs(np.diff(x))))))
    ry = max(1, int(np.ceil(radius_degrees / np.median(np.abs(np.diff(y))))))
    if values.shape != (len(y), len(x)) or len(x) <= 2*rx or len(y) <= 2*ry:
        return []
    from numpy.lib.stride_tricks import sliding_window_view
    def box(data, operation):
        data = operation(sliding_window_view(np.pad(data, ((0, 0), (rx, rx)), constant_values=np.nan), 2*rx+1, axis=1), axis=-1)
        return operation(sliding_window_view(np.pad(data, ((ry, ry), (0, 0)), constant_values=np.nan), 2*ry+1, axis=0), axis=-1)
    lo, hi = box(values, np.min), box(values, np.max)
    selected = []
    for kind, extreme in [('L', lo), ('H', hi)]:
        candidates = []
        for row, col in np.argwhere(np.isfinite(extreme) & (values == extreme)):
            ring = np.concatenate((values[row-ry, col-rx:col+rx+1], values[row+ry, col-rx:col+rx+1], values[row-ry+1:row+ry, col-rx], values[row-ry+1:row+ry, col+rx]))
            value = float(values[row, col])
            prominence = np.min(ring) - value if kind == 'L' else value - np.max(ring)
            if prominence >= prominence_hpa:
                candidates.append({'kind': kind, 'lon': float(x[col]), 'lat': float(y[row]), 'pressure_hpa': value})
        candidates.sort(key=lambda item: item['pressure_hpa'], reverse=kind == 'H')
        accepted = []
        for candidate in candidates:
            def km(other):
                lat1, lat2 = np.radians([candidate['lat'], other['lat']])
                angle = np.sin((lat1-lat2)/2)**2 + np.cos(lat1)*np.cos(lat2)*np.sin(np.radians(candidate['lon']-other['lon'])/2)**2
                return 12742.0176*np.arcsin(np.sqrt(min(1, angle)))
            if all(km(other) >= separation_km for other in accepted):
                accepted.append(candidate)
                if len(accepted) == 6:
                    break
        selected.extend(accepted)
    return selected


def map_annotations(ax, region, centers):
    import matplotlib.patheffects as effects
    stroke = [effects.withStroke(linewidth=2.5, foreground='white')]
    for index, center in enumerate(centers):
        color = '#d02232' if center['kind'] == 'L' else '#1855bd'
        text = ax.text(center['lon'], center['lat'], f"{center['pressure_hpa']:.0f}\n{center['kind']}", ha='center', va='center', color=color, fontsize=13, weight='bold', linespacing=.95, path_effects=stroke, zorder=15, clip_on=True)
        text.set_gid(f"mslp-center-{center['kind']}-{index}")
    west, east, south, north = region['bounds']
    chosen = []
    for place in json.loads((ROOT / 'src/data/map-places.json').read_text()):
        lon = west + (place['lon']-west) % 360
        lat = place['lat']
        if not west < lon < east or not south < lat < north:
            continue
        if any(np.hypot((lon-other[0])/(east-west), (lat-other[1])/(north-south)) < .075 for other in chosen):
            continue
        chosen.append((lon, lat))
        ax.plot(lon, lat, '.', color='#40464b', markersize=2, zorder=12)
        text = ax.annotate(place['code'], (lon, lat), xytext=(3, 3), textcoords='offset points', fontsize=7, color='#444f59', path_effects=stroke, zorder=12, annotation_clip=True)
        text.set_gid('city-' + place['code'])


def render_chart(fields, region, product, run, hour, destination):
    key = {'precip': 'precip', 'wind': 'wind_speed_10m', 'upper': 't500', 'temperature': 'temperature_2m',
           'dewpoint': 'dewpoint', 'cape': 'cape', 'tcwv': 'tcwv', 'temperature850': 't850', 'wind250': 'wind250'}[product]
    x, y, shaded = regional_grid(fields[key], region)
    fig, ax = plt.subplots(figsize=(14, 10), dpi=130)
    fig.subplots_adjust(left=.055, right=.925, bottom=.105, top=.87)
    if product == 'precip':
        _, _, previous = regional_grid(fields['previous_precip'], region)
        shaded = precipitation_rate(shaded, previous)
        levels = [.1, .25, .5, 1, 2, 3, 5, 8, 12, 16, 24, 32]
        cmap = ListedColormap(['#a6fca8', '#42e851', '#08bc32', '#009c2b', '#087627', '#faee00', '#ffc400', '#ff8000', '#fa2020', '#cf0051', '#cb08cf', '#720099'])
        image = ax.contourf(x, y, shaded, levels=levels, cmap=cmap, norm=BoundaryNorm(levels, cmap.N), extend='max', zorder=1)
        _, _, p = regional_grid(fields['pressure_msl'], region)
        _, _, z500 = regional_grid(fields['z500'], region)
        _, _, z1000 = regional_grid(fields['z1000'], region)
        contour(ax, x, y, p, range(880, 1081, 4), '#222222')
        contour(ax, x, y, z500-z1000, range(450, 631, 6), '#d43f45', True)
        title, label = '6-hour Mean Total Precip Rate (mm/h), MSLP (hPa), 1000–500 hPa Thickness (dam)', 'Total precip\nmm/h'
        interval = f"Precip interval: {iso(utc(run['forecast_zero']) + timedelta(hours=hour-6))} to valid time; all types combined."
    elif product == 'wind':
        image = ax.contourf(x, y, shaded, levels=np.arange(0, 121, 5), cmap='turbo', extend='max')
        _, _, p = regional_grid(fields['pressure_msl'], region)
        contour(ax, x, y, p, range(880, 1081, 4), '#222222')
        title, label = '10m Wind Speed (kt) & MSLP (hPa)', 'Wind\nkt'
        interval = 'Native separately trained wind_speed_10m ensemble mean; not a cyclone maximum-wind correction.'
    elif product == 'upper':
        image = ax.contourf(x, y, shaded, levels=np.arange(-65, 11, 2), cmap='turbo', extend='both')
        _, _, z = regional_grid(fields['z500'], region)
        contour(ax, x, y, z, range(450, 631, 6), '#222222')
        title, label, interval = '500 hPa Geopotential Height (dam) & Temperature (°C)', 'Temperature\n°C', 'Geopotential converted to height with standard gravity 9.80665 m/s².'
    elif product == 'temperature':
        image = ax.contourf(x, y, shaded, levels=np.arange(-40, 51, 2), cmap='turbo', extend='both')
        title, label, interval = '2m Temperature (°C)', 'Temperature\n°C', 'Native temperature_2m ensemble mean; kelvin converted to Celsius.'
    elif product == 'dewpoint':
        image = ax.contourf(x, y, shaded, levels=np.arange(-40, 37, 2), cmap='BrBG', extend='both')
        title, label, interval = '2m Dewpoint (°C)', 'Dewpoint\n°C', 'Native dewpoint_2m ensemble mean; kelvin converted to Celsius, not inferred from temperature.'
    elif product == 'cape':
        image = ax.contourf(x, y, shaded, levels=[0, 100, 250, 500, 750, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 6000], cmap='YlOrRd', extend='both')
        title, label, interval = 'Convective Available Potential Energy (J/kg)', 'CAPE\nJ/kg', 'Native cape ensemble mean; parcel definition follows source, not relabelled SBCAPE/MLCAPE or storm probability.'
    elif product == 'tcwv':
        image = ax.contourf(x, y, shaded, levels=np.arange(0, 86, 5), cmap='YlGnBu', extend='both')
        title, label, interval = 'Total Column Water Vapour (kg/m²)', 'Water vapour\nkg/m²', 'Native total_column_water_vapour ensemble mean, unchanged kg/m²; atmospheric column content, NOT precipitation accumulation.'
    elif product == 'temperature850':
        image = ax.contourf(x, y, shaded, levels=np.arange(-45, 41, 2), cmap='turbo', extend='both')
        title, label, interval = '850 hPa Temperature (°C)', 'Temperature\n°C', 'Native temperature_850 ensemble mean at published 850 hPa; kelvin converted to Celsius, no vertical interpolation.'
    elif product == 'wind250':
        image = ax.contourf(x, y, shaded, levels=np.arange(0, 221, 10), cmap='turbo', extend='max')
        title, label, interval = '250 hPa Wind Speed (kt)', 'Wind\nkt', 'Native separately trained wind_speed_250 ensemble mean; m/s converted to kt, not 10m/TC intensity or derived vector wind.'
    else:
        raise ValueError('Unknown forecast product')
    bar = fig.colorbar(image, ax=ax, fraction=.028, pad=.012, shrink=.94)
    bar.ax.tick_params(labelsize=8)
    bar.ax.set_title(label, fontsize=8, pad=10)
    add_geography(ax, region)
    west, east, south, north = region['bounds']
    ax.set(xlim=(west, east), ylim=(south, north))
    centers = pressure_centers(x, y, p) if product in ('precip', 'wind') else []
    map_annotations(ax, region, centers)
    ax.set_xticks(np.arange(np.ceil(west/10)*10, east+.01, 10))
    ax.set_yticks(np.arange(np.ceil(south/10)*10, north+.01, 10))
    ax.xaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f'{abs(v):g}°{"W" if v < 0 else "E"}'))
    ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f'{abs(v):g}°{"S" if v < 0 else "N"}'))
    ax.tick_params(labelsize=9)
    ax.grid(color='#6e7b88', linestyle=':', linewidth=.35, alpha=.5, zorder=6)
    valid = utc(run['forecast_zero']) + timedelta(hours=hour)
    fig.text(.055, .958, f'WM-6 {title}', fontsize=12, weight='bold', color='#183d59')
    fig.text(.055, .927, f"Forecast base (forecast_zero): {run['forecast_zero']}   Provider run: {run['initialization_time']}", fontsize=9)
    fig.text(.055, .9, f"Forecast hour: [{hour:03d}]   Valid: {iso(valid)}   {region['label']}", fontsize=10)
    fig.text(.93, .9, '128-member ensemble mean', fontsize=9, ha='right', color='#486176')
    fig.text(.055, .061, 'L / H: local ensemble-mean MSLP minima / maxima, rounded hPa (not individual cyclone centres). City codes are display abbreviations, not stations.', fontsize=7, color='#455664')
    fig.text(.055, .045, interval, fontsize=8, color='#455664')
    fig.text(.055, .022, 'WindBorne WM-6 0.25° · Generated by GitHub Actions · Natural Earth 1:50m · Forecast guidance, not an official warning', fontsize=8, color='#455664')
    destination.parent.mkdir(parents=True, exist_ok=True)
    metadata = {'Title': f'WM-6 {title}', 'Description': f"Initialization {run['initialization_time']}; forecast_zero {run['forecast_zero']}; +{hour}h; valid {iso(valid)}; ensemble mean. {interval} MSLP local extrema (unrounded hPa): {json.dumps(centers, separators=(',', ':'), allow_nan=False)}"}
    # Keep native 0.25° geometry; palette PNG + lossless gzip SVG fit Pages' size limits.
    from PIL import Image, PngImagePlugin
    image_buffer = io.BytesIO()
    fig.savefig(image_buffer, format='png')
    with Image.open(image_buffer) as image:
        palette = image.convert('RGB').quantize(colors=256, dither=Image.Dither.NONE)
        png_info = PngImagePlugin.PngInfo()
        for name, value in metadata.items():
            png_info.add_text(name, value)
        palette.save(destination.with_suffix('.png'), optimize=True, compress_level=9, pnginfo=png_info)
        palette.close()
    svg_buffer = io.BytesIO()
    fig.savefig(svg_buffer, format='svg', metadata=metadata)
    destination.with_suffix('.svgz').write_bytes(gzip.compress(svg_buffer.getvalue(), compresslevel=9, mtime=0))
    plt.close(fig)


def save_gif(paths, destination):
    from PIL import Image
    if len(paths) < 2:
        return False
    images = []
    try:
        for path in paths:
            with Image.open(path) as image:
                thumbnail = image.convert('RGB')
                thumbnail.thumbnail((910, 650), Image.Resampling.LANCZOS)
                images.append(thumbnail.quantize(colors=128, dither=Image.Dither.NONE))
        destination.parent.mkdir(parents=True, exist_ok=True)
        images[0].save(destination, save_all=True, append_images=images[1:], duration=[900] + [400] * (len(images)-2) + [1200], loop=0, disposal=2)
        return True
    finally:
        for image in images:
            image.close()


def build_animations(record, older, out):
    record['animations'], record['trends'] = {}, {}
    for region in REGIONS:
        rid = region['id']
        record['animations'][rid], record['trends'][rid] = {}, {}
        for product in PRODUCTS:
            pid = product['id']
            frames = [frame for frame in record['frames'] if frame['files'].get(rid, {}).get(pid)]
            prefix = Path('runs') / record['id'] / rid / pid
            gif = prefix / 'forecast.gif'
            if save_gif([out / frame['files'][rid][pid]['png'] for frame in frames], out / gif):
                record['animations'][rid][pid] = str(gif)
            if not older:
                continue
            previous = {frame['validTime']: frame for frame in older.get('frames', []) if frame['files'].get(rid, {}).get(pid)}
            trends = {}
            for frame in frames:
                old = previous.get(frame['validTime'])
                if not old:
                    continue
                old_path = out / old['files'][rid][pid]['png']
                if not old_path.is_file():
                    continue
                gif = prefix / f"trend-{frame['hour']:03d}.gif"
                if save_gif([old_path, out / frame['files'][rid][pid]['png']], out / gif):
                    trends[str(frame['hour'])] = str(gif)
            record['trends'][rid][pid] = trends


GENERATOR_VERSION = 'native-zarr-v4-variables'


def frame_assets_complete(frame, record, out):
    """Only trust the pinned run's expected public paths and valid-time anchor."""
    try:
        hour = frame['hour']
        if not isinstance(hour, int) or hour < 0 or hour > 312 or hour % 6:
            return False
        if utc(frame['validTime']) != utc(record['forecastZero']) + timedelta(hours=hour):
            return False
        for region in REGIONS:
            for product in PRODUCTS:
                if hour == 0 and product['id'] == 'precip':
                    continue
                files = frame['files'][region['id']][product['id']]
                prefix = f"runs/{record['id']}/{region['id']}/{product['id']}/{hour:03d}"
                if files['png'] != prefix + '.png' or files['svg'] not in (prefix + '.svg', prefix + '.svgz'):
                    return False
                if any(not (out / files[key]).is_file() or (out / files[key]).stat().st_size == 0 for key in ('png', 'svg')):
                    return False
        return True
    except (KeyError, TypeError, ValueError, OSError):
        return False


def cached_forecast_base(previous, forecast_zero, out):
    """A base selects one provider version; hourly provider changes do not replace it."""
    for record in previous.get('runs', []):
        try:
            if record.get('generatorVersion') in (GENERATOR_VERSION, 'native-zarr-v3-time') and utc(record['forecastZero']) == utc(forecast_zero) and record['id'] == run_id(record['initializationTime']) and (out / 'runs' / record['id']).is_dir():
                return record
        except (KeyError, TypeError, ValueError):
            continue
    return None


def base_assets_complete(record, requested, out):
    frames = {frame['hour']: frame for frame in record.get('frames', [])}
    return bool(requested) and all(hour in frames and frame_assets_complete(frames[hour], record, out) for hour in requested)


def generate(args):
    key = os.environ.get('WM_API_KEY')
    if not key:
        raise RuntimeError('WM_API_KEY secret is required')
    session = requests.Session()
    session.headers.update({'Authorization': f'Bearer {key}'})
    params = {} if args.initialization == 'latest' else {'initialization_time': iso(utc(args.initialization))}
    with request(session, '/run_information', params) as response:
        run = response.json()
    if args.initialization != 'latest' and utc(run['initialization_time']) != utc(args.initialization):
        raise ValueError('Requested initialization mismatch')
    utc(run['forecast_zero'])
    available = sorted({int(item['forecast_hour']) for item in run['available'] if 0 <= int(item['forecast_hour']) <= 312})
    hours = [hour for hour in available if hour % 6 == 0 and hour <= args.max_hour]
    if not hours:
        raise ValueError('No available 6-hourly forecast frames in requested window')
    requested = {int(value) for value in args.hours.split(',')} if args.hours else set(hours)
    if not requested or any(hour < 0 or hour > args.max_hour or hour % 6 for hour in requested):
        raise ValueError('Requested hours must be comma-separated 0–312h multiples of six')
    if not requested.intersection(hours):
        raise ValueError('No requested forecast hours are currently available')
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    manifest_path = out / 'index.json'
    previous = json.loads(manifest_path.read_text()) if manifest_path.exists() else {'runs': []}
    base_record = cached_forecast_base(previous, run['forecast_zero'], out)
    force = bool(getattr(args, 'force', False))
    if base_record and not force:
        if base_assets_complete(base_record, requested.intersection(hours), out):
            print(f"Forecast base {base_record['forecastZero']} already published with provider {base_record['initializationTime']}; no hourly-version regeneration or publication.", flush=True)
            return False
        if utc(base_record['initializationTime']) != utc(run['initialization_time']):
            if args.initialization != 'latest':
                raise ValueError('This forecast base is pinned to a different provider version; use --force to explicitly replace it')
            print(f"Repairing incomplete forecast base with its original provider {base_record['initializationTime']}, not mixing hourly versions.", flush=True)
            with request(session, '/run_information', {'initialization_time': base_record['initializationTime']}) as response:
                pinned = response.json()
            if utc(pinned['initialization_time']) != utc(base_record['initializationTime']) or utc(pinned['forecast_zero']) != utc(base_record['forecastZero']):
                raise ValueError('Pinned forecast-base metadata mismatch; preserving published charts')
            run = pinned
            available = sorted({int(item['forecast_hour']) for item in run['available'] if 0 <= int(item['forecast_hour']) <= 312})
            hours = [hour for hour in available if hour % 6 == 0 and hour <= args.max_hour]
            if not requested.intersection(hours) or base_assets_complete(base_record, requested.intersection(hours), out):
                print('Original pinned version has no additional available requested charts; preserving its dated publication.', flush=True)
                return False
    identifier = run_id(run['initialization_time'])
    current_directory = out / 'runs' / identifier
    cached_run = base_record if base_record and base_record['id'] == identifier and not force else None
    if current_directory.is_dir() and cached_run is None:
        shutil.rmtree(current_directory)
    record = {'id': identifier, 'initializationTime': iso(utc(run['initialization_time'])), 'forecastZero': iso(utc(run['forecast_zero'])), 'generatedAt': '', 'upstreamInProgress': bool(run.get('in_progress')), 'upstreamHours': available, 'requestedMaxHour': args.max_hour, 'frames': [], 'failures': []}
    record['generatorVersion'] = GENERATOR_VERSION
    record['mslpCenters'] = True
    record['requestedHours'] = sorted(requested)
    verified = False
    new_charts = 0
    for hour in hours:
        cached = next((frame for frame in (cached_run or {}).get('frames', []) if frame['hour'] == hour), None)
        if cached and frame_assets_complete(cached, cached_run, out):
            record['frames'].append(cached)
            print(f'Reusing verified WM-6 {identifier} +{hour:03d}h chart assets', flush=True)
            continue
        if hour not in requested:
            continue
        print(f'Generating WM-6 {identifier} +{hour:03d}h', flush=True)
        fields = {}
        selected = list(FIELDS) if hour >= 6 and hour-3 in available else [field for field in FIELDS if field != 'precip']
        try:
            fields.update(download_archive_fields(session, run, hour, selected))
        except (RuntimeError, ValueError, KeyError, OSError) as error:
            record['failures'].append({'hour': hour, 'field': 'ensemble_mean_archive', 'reason': str(error)[:160]})
        for key in selected:
            if key not in fields:
                record['failures'].append({'hour': hour, 'field': key, 'reason': 'Native field absent or failed validation; no fill/substitute'})
        if 'precip' in fields:
            try:
                fields.update(download_archive_fields(session, run, hour-3, ['previous_precip']))
            except (RuntimeError, ValueError, KeyError, OSError) as error:
                record['failures'].append({'hour': hour, 'field': 'previous_precip', 'reason': str(error)[:160]})
        if fields:
            first = next(iter(fields.values()))
            if any(not np.array_equal(first[0], field[0]) or not np.array_equal(first[1], field[1]) for field in fields.values()):
                raise ValueError('Grid coordinates mismatch')
        if not verified and fields:
            reference_key = 'pressure_msl' if 'pressure_msl' in fields else next(iter(fields))
            reference = regional_grid(download_field(session, run, hour, reference_key), {'bounds': [-180, 180, -90, 90]})
            candidate = regional_grid(fields[reference_key], {'bounds': [-180, 180, -90, 90]})
            if any(not np.allclose(left, right, rtol=1e-6, atol=1e-6, equal_nan=True) for left, right in zip(reference, candidate)):
                raise ValueError('Archive/NetCDF physical-value verification failed')
            verified = True
            print(f'Native archive agrees with independently served NetCDF {reference_key} and coordinates.', flush=True)
        frame = {'hour': hour, 'validTime': iso(utc(run['forecast_zero']) + timedelta(hours=hour)), 'files': {}}
        for region in REGIONS:
            frame['files'][region['id']] = {}
            for product in PRODUCTS:
                name = product['id']
                if not all(field in fields for field in REQUIRED[name]):
                    continue
                path = Path('runs') / identifier / region['id'] / name / f'{hour:03d}'
                render_chart(fields, region, name, run, hour, out / path)
                new_charts += 1
                frame['files'][region['id']][name] = {'png': str(path.with_suffix('.png')), 'svg': str(path.with_suffix('.svgz'))}
        if any(frame['files'][region['id']] for region in REGIONS):
            record['frames'].append(frame)
    if not record['frames']:
        raise RuntimeError('No real charts generated; refusing to replace published charts')
    if cached_run and new_charts == 0:
        print('::warning::No new usable charts in pinned repair; preserving the prior publication timestamp and manifest.', flush=True)
        return False
    history = sorted([item for item in previous.get('runs', []) if item.get('id') != identifier and item.get('id', '').isalnum() and item.get('forecastZero') and utc(item['forecastZero']) != utc(record['forecastZero']) and (out / 'runs' / item['id']).is_dir()], key=lambda item: utc(item['forecastZero']), reverse=True)[:1]
    records = sorted([record] + history, key=lambda item: utc(item['forecastZero']), reverse=True)
    older = next((item for item in history if utc(item['forecastZero']) < utc(record['forecastZero'])), None)
    build_animations(record, older, out)
    record['generatedAt'] = iso(datetime.now(timezone.utc))
    def site_bytes(items):
        return sum(path.stat().st_size for item in items for path in (out / 'runs' / item['id']).rglob('*') if path.is_file())
    budget = 900 * 1024 * 1024
    if site_bytes(records) > budget and len(records) > 1:
        records.pop()
        print('::warning::Previous run pruned to keep the published site under 900 MiB.')
    if site_bytes(records) > budget:
        raise RuntimeError('Generated chart site exceeds publication budget; refusing to replace published charts')
    manifest = {'version': 1, 'model': 'WM-6', 'statistic': 'ensemble_mean', 'ensembleSize': 128, 'resolutionDegrees': .25, 'products': PRODUCTS, 'regions': REGIONS, 'runs': records}
    temporary = out / 'index.next.json'
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')))
    temporary.replace(manifest_path)
    for directory in (out / 'runs').iterdir():
        if directory.is_dir() and directory.name not in {item['id'] for item in records}:
            shutil.rmtree(directory)
    print(f"Published manifest: {len(record['frames'])} hours, {len(record['failures'])} field failures", flush=True)
    if record['failures']:
        print('::warning::Some WM-6 fields were unavailable; missing products are disabled, not fabricated.')
    return True


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--initialization', default='latest')
    parser.add_argument('--max-hour', type=int, default=312, choices=range(0, 313, 6))
    parser.add_argument('--hours', default='', help='Optional comma-separated published hours; empty generates all available 6-hourly frames')
    parser.add_argument('--output', default='.generated-site/forecast-models')
    parser.add_argument('--force', action='store_true', help='Explicitly replace the selected forecast base; rebuild requested hours rather than reuse its pinned publication')
    changed = generate(parser.parse_args())
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            output.write(f"changed={'true' if changed else 'false'}\n")
