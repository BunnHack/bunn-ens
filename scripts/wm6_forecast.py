#!/usr/bin/env python3
"""Generate real WM-6 ensemble-mean charts; credentials and native grids stay private."""
import argparse
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
]
FIELDS = {
    'pressure_msl': ('pressure_msl', None),
    'z500': ('geopotential', 500), 'z1000': ('geopotential', 1000),
    't500': ('temperature', 500), 'temperature_2m': ('temperature_2m', None),
    'wind_speed_10m': ('wind_speed_10m', None),
    'precip': ('total_precipitation_3h', None),
}
REQUIRED = {'precip': ['pressure_msl', 'z500', 'z1000', 'precip', 'previous_precip'],
            'wind': ['wind_speed_10m', 'pressure_msl'], 'upper': ['z500', 't500'],
            'temperature': ['temperature_2m']}


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
    if scalar(attrs.get('model')) != 'wm-6':
        raise ValueError('Unexpected NetCDF model')
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
        'precip': {'mm'}, 'previous_precip': {'mm'},
    }
    if unit not in acceptable[kind]:
        raise ValueError(f'Unsupported units for {kind}')
    values = np.asarray(values, dtype=np.float64)
    if kind == 'pressure_msl':
        return values / 100
    if kind in ('z500', 'z1000'):
        return values / G / 10  # geopotential -> geopotential height in decametres
    if kind in ('t500', 'temperature_2m'):
        return values - 273.15
    if kind == 'wind_speed_10m':
        return values * 3600 / 1852  # native m/s -> kt; unrelated to cyclone max_wind_kt
    return values


def precipitation_rate(current, previous):
    """Two adjoining, same-run 3h accumulations / 6h, never a made-up rain/snow split."""
    return (np.asarray(current) + np.asarray(previous)) / 6


def request(session, path, params=None):
    for attempt in range(5):
        try:
            response = session.get(API + path, params=params, timeout=(20, 120))
            if response.status_code in (429, 500, 502, 503, 504) and attempt < 4:
                try:
                    delay = float(response.headers.get('Retry-After', '30' if response.status_code == 429 else '5'))
                except ValueError:
                    delay = 30
                response.close()
                time.sleep(min(120, max(1, delay) * (attempt + 1)))
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


def render_chart(fields, region, product, run, hour, destination):
    key = {'precip': 'precip', 'wind': 'wind_speed_10m', 'upper': 't500', 'temperature': 'temperature_2m'}[product]
    x, y, shaded = regional_grid(fields[key], region)
    fig, ax = plt.subplots(figsize=(14, 10), dpi=130)
    fig.subplots_adjust(left=.055, right=.925, bottom=.085, top=.87)
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
    else:
        image = ax.contourf(x, y, shaded, levels=np.arange(-40, 51, 2), cmap='turbo', extend='both')
        title, label, interval = '2m Temperature (°C)', 'Temperature\n°C', 'Native temperature_2m ensemble mean; kelvin converted to Celsius.'
    bar = fig.colorbar(image, ax=ax, fraction=.028, pad=.012, shrink=.94)
    bar.ax.tick_params(labelsize=8)
    bar.ax.set_title(label, fontsize=8, pad=10)
    add_geography(ax, region)
    west, east, south, north = region['bounds']
    ax.set(xlim=(west, east), ylim=(south, north))
    ax.set_xticks(np.arange(np.ceil(west/10)*10, east+.01, 10))
    ax.set_yticks(np.arange(np.ceil(south/10)*10, north+.01, 10))
    ax.xaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f'{abs(v):g}°{"W" if v < 0 else "E"}'))
    ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f'{abs(v):g}°{"S" if v < 0 else "N"}'))
    ax.tick_params(labelsize=9)
    ax.grid(color='#6e7b88', linestyle=':', linewidth=.35, alpha=.5, zorder=6)
    valid = utc(run['forecast_zero']) + timedelta(hours=hour)
    fig.text(.055, .958, f'WM-6 {title}', fontsize=12, weight='bold', color='#183d59')
    fig.text(.055, .927, f"Init: {run['initialization_time']}   Forecast zero: {run['forecast_zero']}", fontsize=9)
    fig.text(.055, .9, f"Forecast hour: [{hour:03d}]   Valid: {iso(valid)}   {region['label']}", fontsize=10)
    fig.text(.93, .9, '128-member ensemble mean', fontsize=9, ha='right', color='#486176')
    fig.text(.055, .045, interval, fontsize=8, color='#455664')
    fig.text(.055, .022, 'WindBorne WM-6 0.25° · Generated by GitHub Actions · Natural Earth 1:50m · Forecast guidance, not an official warning', fontsize=8, color='#455664')
    destination.parent.mkdir(parents=True, exist_ok=True)
    metadata = {'Title': f'WM-6 {title}', 'Description': f"Initialization {run['initialization_time']}; forecast_zero {run['forecast_zero']}; +{hour}h; valid {iso(valid)}; ensemble mean. {interval}"}
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
    identifier = run_id(run['initialization_time'])
    available = sorted({int(item['forecast_hour']) for item in run['available'] if 0 <= int(item['forecast_hour']) <= 312})
    hours = [hour for hour in available if hour % 6 == 0 and hour <= args.max_hour]
    if not hours:
        raise ValueError('No available 6-hourly forecast frames in requested window')
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    manifest_path = out / 'index.json'
    previous = json.loads(manifest_path.read_text()) if manifest_path.exists() else {'runs': []}
    current_directory = out / 'runs' / identifier
    if current_directory.is_dir():
        shutil.rmtree(current_directory)  # never leave old products mixed into a regenerated run
    record = {'id': identifier, 'initializationTime': iso(utc(run['initialization_time'])), 'forecastZero': iso(utc(run['forecast_zero'])), 'generatedAt': '', 'upstreamInProgress': bool(run.get('in_progress')), 'upstreamHours': available, 'requestedMaxHour': args.max_hour, 'frames': [], 'failures': []}
    for hour in hours:
        print(f'Generating WM-6 {identifier} +{hour:03d}h', flush=True)
        fields = {}
        selected = list(FIELDS) if hour >= 6 and hour-3 in available else [field for field in FIELDS if field != 'precip']
        def fetch_field(field):
            with requests.Session() as connection:
                connection.headers.update(session.headers)
                return download_field(connection, run, hour-3 if field == 'previous_precip' else hour, field)
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = {field: pool.submit(fetch_field, field) for field in selected + (['previous_precip'] if 'precip' in selected else [])}
            for field, future in futures.items():
                try:
                    fields[field] = future.result()
                    if field != next(iter(fields)):
                        first = next(iter(fields.values()))
                        if not np.array_equal(first[0], fields[field][0]) or not np.array_equal(first[1], fields[field][1]):
                            raise ValueError('Grid coordinates mismatch')
                except (RuntimeError, ValueError, KeyError, OSError) as error:
                    fields.pop(field, None)
                    record['failures'].append({'hour': hour, 'field': field, 'reason': str(error)[:160]})
        frame = {'hour': hour, 'validTime': iso(utc(run['forecast_zero']) + timedelta(hours=hour)), 'files': {}}
        for region in REGIONS:
            frame['files'][region['id']] = {}
            for product in PRODUCTS:
                name = product['id']
                if not all(field in fields for field in REQUIRED[name]):
                    continue
                path = Path('runs') / identifier / region['id'] / name / f'{hour:03d}'
                render_chart(fields, region, name, run, hour, out / path)
                frame['files'][region['id']][name] = {'png': str(path.with_suffix('.png')), 'svg': str(path.with_suffix('.svgz'))}
        if any(frame['files'][region['id']] for region in REGIONS):
            record['frames'].append(frame)
    if not record['frames']:
        raise RuntimeError('No real charts generated; refusing to replace published charts')
    history = [item for item in previous.get('runs', []) if item.get('id') != identifier and item.get('id', '').isalnum() and (out / 'runs' / item['id']).is_dir()][:1]
    records = sorted([record] + history, key=lambda item: utc(item['initializationTime']), reverse=True)
    older = next((item for item in history if utc(item['initializationTime']) < utc(record['initializationTime'])), None)
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


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--initialization', default='latest')
    parser.add_argument('--max-hour', type=int, default=312, choices=range(0, 313, 6))
    parser.add_argument('--output', default='.generated-site/forecast-models')
    generate(parser.parse_args())
