#!/usr/bin/env python3
"""Public AIGFS MSLP L-centre tracks and unmodified Tianji SD3 native tracks.
No wind inference, operational cyclone classification, cross-model mean, or private input.
"""
from __future__ import annotations
import argparse
import datetime as dt
import hashlib
import io
import json
import math
import re
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
import numpy as np
from scipy.ndimage import minimum_filter, label

UTC = dt.timezone.utc
PUBLIC = 'https://tropical-tidbits-material.pages.dev/api/wmc'
NOAA = 'https://nomads.ncep.noaa.gov/pub/data/nccf/com/aigfs/prod/'
SD3 = 'https://tj-nwp.s3-us-west-2.amazonaws.com/'
PUBLISHED = 'https://raw.githubusercontent.com/BunnHack/bunn-ens/model-track-data/index.json'
HOSTS = {'nomads.ncep.noaa.gov', 'tj-nwp.s3-us-west-2.amazonaws.com', 'tropical-tidbits-material.pages.dev', 'raw.githubusercontent.com'}
VERSION = 'low-centres-v1'
METHOD = '本站原生0.25° MSLP低压L追踪；WMC同UTC预报位置仅作初始参考，非实测。3×3局地极小值，250km八方向闭合≥0.5hPa，≤1015hPa；初始≤250km，其后≤85km/h，最近两候选距离差<75km则停止；缺时次/无闭合L即停止。仅低压中心，不保证热带结构或气旋身份；不推算风速/Cat。'
_last_request = 0.0


def iso(value):
    return value.astimezone(UTC).isoformat(timespec='seconds').replace('+00:00', 'Z')


def utc(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}Z?', value):
        raise ValueError('WMC reference must use its documented UTC point format')
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).replace(tzinfo=UTC)


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parts = urllib.parse.urlsplit(newurl)
        if parts.scheme != 'https' or parts.hostname not in HOSTS or parts.username or parts.password:
            raise ValueError('Unsafe public-source redirect')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


OPENER = urllib.request.build_opener(SafeRedirect())


def get(url, limit=2_000_000, headers=None):
    global _last_request
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != 'https' or parts.hostname not in HOSTS or parts.username or parts.password:
        raise ValueError('Unapproved public source')
    # NOMADS public-service request budget, including index reads; no authenticated calls.
    time.sleep(max(0, .7 - (time.monotonic() - _last_request)))
    _last_request = time.monotonic()
    req = urllib.request.Request(url, headers={'User-Agent': 'Bunn-ENS-public-low-tracker/1.0', **(headers or {})})
    with OPENER.open(req, timeout=40) as response:
        if headers and 'Range' in headers and response.status != 206:
            raise ValueError('Range response must be HTTP 206')
        data = response.read(limit + 1)
        if len(data) > limit:
            raise ValueError('Public source size limit')
        return data, dict(response.headers)


def distance(a, b):
    lat1, lat2 = math.radians(a['lat']), math.radians(b['lat'])
    h = math.sin((lat2-lat1)/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(math.radians(b['lon']-a['lon'])/2)**2
    return 12742 * math.asin(min(1, math.sqrt(h)))


def seeds_at(payload, base):
    """One unambiguous actual same-UTC WMC forecast fix per original source code."""
    groups = {}
    for entry in payload.get('entries', []):
        code, model = str(entry.get('xuhao', '')), entry.get('FCSTType', '')
        if not re.fullmatch(r'[12]\d{7}', code):
            continue
        for p in entry.get('points', []):
            try:
                zero, valid = utc(p['datetime']), utc(p['validtime'])
                lead = p['fcsthour']
                if type(lead) not in (int, float) or not math.isfinite(lead) or not 0 <= lead <= 312 or int(lead) != lead:
                    continue
                if valid != base or valid != zero + dt.timedelta(hours=lead) or str(p['xuhao']) != code or p['fcsttype'] != model:
                    continue
                lat, lon = float(p['lat']), float(p['lon'])
                name = str(p.get('engname', '')).upper()
                if not name or name != str(entry.get('enname', '')).upper() or not math.isfinite(lat+lon) or abs(lat)>70 or abs(lon)>180:
                    continue
                groups.setdefault(code, []).append(dict(code=code, name=name, basin=str(p.get('zone', '')), model=model, forecastZero=iso(zero), leadHours=lead, validTime=iso(valid), lat=lat, lon=lon))
            except (ValueError, TypeError, KeyError):
                continue
    result = []
    for fixes in groups.values():
        preferred = sorted(fixes, key=lambda p: (p['model'] != 'FUXI', p['model']))
        if len({(p['lat'], p['lon']) for p in preferred if p['model'] == preferred[0]['model']}) == 1:
            result.append(preferred[0])
    return result[:30]


def read_grib(data, base, lead):
    """Validate actual message identity, units and grid; no filename-only trust."""
    import eccodes as ec
    if data[:4] != b'GRIB' or data[-4:] != b'7777' or len(data) < 20 or int.from_bytes(data[8:16], 'big') != len(data):
        raise ValueError('Incomplete or multiple GRIB messages')
    with tempfile.TemporaryFile() as f:
        f.write(data); f.seek(0)
        gid = ec.codes_grib_new_from_file(f)
        if gid is None:
            raise ValueError('No GRIB message')
        try:
            g = lambda k: ec.codes_get(gid, k)
            if g('shortName') not in ('prmsl', 'msl') or g('typeOfLevel') != 'meanSea' or g('units') != 'Pa':
                raise ValueError('Not mean-sea-level pressure in Pa')
            if (int(g('dataDate')), int(g('dataTime'))) != (int(base.strftime('%Y%m%d')), base.hour*100):
                raise ValueError('GRIB cycle mismatch')
            if int(g('endStep')) != lead or str(g('stepUnits')) != '1' or g('stepType') != 'instant':
                raise ValueError('GRIB forecast step mismatch')
            if (int(g('validityDate')), int(g('validityTime'))) != (int((base+dt.timedelta(hours=lead)).strftime('%Y%m%d')), (base+dt.timedelta(hours=lead)).hour*100):
                raise ValueError('GRIB valid UTC mismatch')
            ni, nj = int(g('Ni')), int(g('Nj'))
            if ni != 1440 or nj not in (720,721) or int(g('jPointsAreConsecutive')) != 0 or int(g('alternativeRowScanning')) != 0 or abs(float(g('iDirectionIncrementInDegrees'))-.25)>1e-6 or abs(float(g('jDirectionIncrementInDegrees'))-.25)>1e-6:
                raise ValueError('Unexpected native latitude/longitude grid')
            pressure = np.asarray(ec.codes_get_values(gid), dtype=float).reshape(nj, ni) / 100
            lats = np.asarray(ec.codes_get_array(gid, 'latitudes'), dtype=float).reshape(nj,ni)[:,0]
            lons = np.asarray(ec.codes_get_array(gid, 'longitudes'), dtype=float).reshape(nj,ni)[0,:]
            if not np.all(np.isfinite(pressure)) or np.min(pressure)<750 or np.max(pressure)>1150 or len(np.unique(lons)) != ni or not np.allclose(abs(np.diff(lats)), .25):
                raise ValueError('Invalid native pressure/coordinates')
            return pressure, lats, lons
        finally:
            ec.codes_release(gid)


def pressure_range(index, base, lead):
    lines = [line.split(':') for line in index.splitlines() if line.strip()]
    matches = [(i,p) for i,p in enumerate(lines) if len(p)>=6 and p[3:5] == ['PRMSL','mean sea level']]
    if len(matches) != 1:
        raise ValueError('Unique PRMSL index entry required')
    i,p = matches[0]
    expected = 'anl' if lead == 0 else f'{lead} hour fcst'
    if p[2] != 'd='+base.strftime('%Y%m%d%H') or p[5] != expected:
        raise ValueError('MSLP index time mismatch')
    start = int(p[1]); end = int(lines[i+1][1])-1 if i+1<len(lines) else None
    if start < 0 or (end is not None and (end < start or end-start>8_000_000)):
        raise ValueError('Invalid pressure byte range')
    return start, end


def aigfs_field(directory, base, lead):
    url = directory + f'aigfs.t{base.hour:02d}z.sfc.f{lead:03d}.grib2'
    idx, _ = get(url+'.idx', 100_000)
    start, end = pressure_range(idx.decode('ascii'), base, lead)
    data, headers = get(url, 8_000_000, {'Range':f'bytes={start}-{end if end is not None else ""}'})
    content_range = next((v for k,v in headers.items() if k.lower()=='content-range'), '')
    m = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', content_range)
    if not m or int(m[1]) != start or int(m[2])+1-start != len(data) or int(m[3])<=int(m[2]) or (end is not None and int(m[2])!=end) or (end is None and int(m[2])+1!=int(m[3])):
        raise ValueError('Invalid pressure Content-Range')
    return read_grib(data, base, lead), {'url':url,'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'range':content_range}


def find_lows(grid, lats, lons, reference, radius):
    """Native-grid closed lows only; periodic longitude and geographic-distance gate."""
    rows = np.flatnonzero(abs(lats-reference['lat']) <= radius/111.0 + 3)
    delta_lon = (lons-reference['lon']+180)%360-180
    cols = np.flatnonzero(abs(delta_lon) <= radius/(111*max(.15,math.cos(math.radians(reference['lat']))))+4)
    if not len(rows) or not len(cols):
        return []
    cols = cols[np.argsort(delta_lon[cols])]
    sub = grid[np.ix_(rows, cols)]
    local = (sub == minimum_filter(sub, size=3, mode='constant', cval=-np.inf)) & (sub<=1015)
    # A flat minimum/plateau is not an independently identified centre.
    components, count = label(local)
    lows=[]
    for ident in range(1, count+1):
        places = np.argwhere(components==ident)
        if len(places)!=1:
            continue
        y,x = places[0]; yi,xi = int(rows[y]),int(cols[x])
        p={'lat':float(lats[yi]), 'lon':float((lons[xi]+180)%360-180), 'pressureHpa':float(grid[yi,xi])}
        if abs(p['lat'])>75 or distance(reference,p)>radius:
            continue
        ring=[]
        for angle in range(0,360,45):
            a=math.radians(angle); angular=250/6371
            lat1=math.radians(p['lat']); lon1=math.radians(p['lon'])
            lat2=math.asin(math.sin(lat1)*math.cos(angular)+math.cos(lat1)*math.sin(angular)*math.cos(a))
            lon2=lon1+math.atan2(math.sin(a)*math.sin(angular)*math.cos(lat1),math.cos(angular)-math.sin(lat1)*math.sin(lat2))
            ry=int(np.argmin(abs(lats-math.degrees(lat2))))
            rx=int(np.argmin(abs((lons-math.degrees(lon2)+180)%360-180)))
            ring.append(grid[ry,rx]-p['pressureHpa'])
        if min(ring)>=.5:
            lows.append(p)
    return sorted(lows,key=lambda p:distance(reference,p))


def choose_low(candidates, reference):
    if not candidates:
        return None, '无符合闭合条件的低压L，停止追踪；不延伸或补点。'
    ranked=sorted(candidates,key=lambda p:distance(reference,p))
    if len(ranked)>1 and distance(reference,ranked[1])-distance(reference,ranked[0])<75:
        return None, '两个低压候选距离接近，身份有歧义；停止追踪。'
    return ranked[0], ''


def discover_aigfs(now):
    boundary=now.replace(hour=(now.hour//6)*6,minute=0,second=0,microsecond=0)
    for offset in range(8):
        base=boundary-dt.timedelta(hours=6*offset)
        directory=NOAA+base.strftime('aigfs.%Y%m%d/%H/model/atmos/grib2/')
        try:
            data,_=get(directory,200_000)
            names=re.findall(r'href=[\"\x27]([^\"\x27]+)',data.decode('ascii'),re.I)
            if all(f'aigfs.t{base.hour:02d}z.sfc.f{h:03d}.grib2' in names for h in range(0,385,6)):
                return base,directory
        except (urllib.error.URLError, ValueError, UnicodeError):
            continue
    raise ValueError('No complete published 0–384h AIGFS surface run in 48h')


def generate_aigfs(now, seeds_payload):
    base,directory=discover_aigfs(now)
    seeds=seeds_at(seeds_payload,base)
    if not seeds:
        raise ValueError('No valid same-UTC WMC reference forecast fixes for this AIGFS run')
    tracks=[dict(model='AIGFS',systemId='WMC:'+s['code'],name=s['name'],basin=s['basin'],kind='low',source=directory,directoryRun=iso(base),timeOrigin=iso(base),method=METHOD,seed=s,attribution='NOAA/NCEP AIGFS; 本站低压中心追踪',license='NOAA open data',notes=['WMC初始参考来自传统HTTP上游；非实测、非官方跨来源身份映射。'],points=[],fields=[],endReason='') for s in seeds]
    for lead in range(0,385,6):
        active=[t for t in tracks if not t['endReason']]
        if not active:
            break
        try:
            (grid,lats,lons),field=aigfs_field(directory,base,lead)
        except Exception as error:
            print(f'AIGFS +{lead}h validation stopped: {type(error).__name__}: {str(error)[:240]}', flush=True)
            for t in active:
                t['endReason']=f'+{lead}h格点未能验证；在最后有效位置停止，不混用其他时次或起报。'
            break
        selections=[]
        for t in active:
            reference=t['points'][-1] if t['points'] else t['seed']
            point,reason=choose_low(find_lows(grid,lats,lons,reference,510 if t['points'] else 250),reference)
            selections.append((t,point,reason))
        # Two independent seeds must never silently acquire the same low centre.
        for t,p,reason in selections:
            if p is not None and any(other is not t and q is not None and distance(p,q)<1 for other,q,_ in selections):
                p=None;reason='多个来源种子指向同一低压L，停止而不合并系统。'
            if p is None:
                t['endReason']=reason
            else:
                t['points'].append({**p,'leadHours':lead,'validTime':iso(base+dt.timedelta(hours=lead)),'windMs':None})
                t['fields'].append(field)
        print(f'AIGFS {iso(base)} +{lead:03d}h validated; {sum(bool(t["points"]) for t in tracks)} systems',flush=True)
    tracks=[t for t in tracks if len(t['points'])>=2]
    if not tracks:
        raise ValueError('No unambiguous consecutive AIGFS low-centre track')
    return tracks,dict(model='AIGFS',status='available' if all(t['points'][-1]['leadHours']==384 for t in tracks) else 'partial',run=iso(base),message='最新目录中已列出完整0–384h表面场的起报；仅发布通过验证的连续L位置，不保证低压全程维持闭合。')


def parse_sd3(data, key):
    from netCDF4 import Dataset, num2date
    match=re.fullmatch(r'typhoon-track/\d{4}/\d{2}/(\d{8})/(00|12)z/tc_([A-Z]+)_([A-Z0-9-]+)_track\.nc',key)
    if not match:
        raise ValueError('Invalid SD3 object key')
    with Dataset('public-track.nc',memory=data) as f:
        required={'lat':'degree_north','lon':'degree_east','mslp':'hPa','vmax':'m/s'}
        for name,unit in required.items():
            if name not in f.variables or getattr(f.variables[name],'units',None)!=unit or len(f.variables[name].shape)!=1:
                raise ValueError('SD3 coordinate/intensity units mismatch')
        if 'time' not in f.variables or getattr(f.variables['time'],'calendar','standard') not in ('standard','gregorian','proleptic_gregorian'):
            raise ValueError('Unsupported SD3 calendar')
        timevar=f.variables['time']; times=num2date(timevar[:],timevar.units,getattr(timevar,'calendar','standard'),only_use_cftime_datetimes=False,only_use_python_datetimes=True)
        if not 2<=len(times)<=100 or any(len(f.variables[k])!=len(times) for k in required):
            raise ValueError('Invalid SD3 track dimensions')
        origin=times[0].replace(tzinfo=UTC)
        directory=dt.datetime.strptime(match[1]+match[2],'%Y%m%d%H').replace(tzinfo=UTC)
        if not 0<=(origin-directory).total_seconds()<=86400:
            raise ValueError('SD3 file dates inconsistent with directory version')
        points=[]
        def finite(name,i):
            value=f.variables[name][i]
            return float(value) if not np.ma.is_masked(value) and math.isfinite(float(value)) else None
        for i,date in enumerate(times):
            date=date.replace(tzinfo=UTC); lead=(date-origin).total_seconds()/3600
            lat,lon,pressure,wind=[finite(k,i) for k in required]
            if lat is None or lon is None or abs(lat)>90 or not -180<=lon<=360 or not 0<=lead<=384 or int(lead)!=lead:
                continue
            if any(p['leadHours']>=lead for p in points):
                raise ValueError('SD3 duplicate or unordered times')
            points.append(dict(lat=lat,lon=(lon+180)%360-180,pressureHpa=pressure if pressure is not None and pressure>0 else None,windMs=wind if wind is not None and wind>=0 else None,leadHours=int(lead),validTime=iso(date)))
        if len(points)<2:
            raise ValueError('Insufficient SD3 native fixes')
        basin={'WNP':'W','ENP':'E','NA':'L','NAT':'L','NIO':'B','SIO':'S','SP':'P'}.get(match[3],match[3])
        return dict(model='SD3',systemId='SD3:'+match[3]+':'+match[4],name=match[4],basin=basin,kind='native',source=SD3+key,directoryRun=iso(directory),timeOrigin=iso(origin),sourceTimeUnits=timevar.units,method='天机源文件原生路径，不做低压重追踪；时间按NetCDF time units/calendar换算UTC，目录版本标签不冒充起报。',notes=['未获文件内独立起报定义；目录时次与首个有效时间分别保留。', 'NetCDF title: '+str(getattr(f,'title','未提供'))[:100]+'; source: '+str(getattr(f,'source','未提供'))[:300]],attribution=str(getattr(f,'institution','TianJi Weather Science and Technology Company')),license=str(getattr(f,'license','unknown')),points=points,fields=[dict(url=SD3+key,sha256=hashlib.sha256(data).hexdigest(),bytes=len(data))],endReason='')


def generate_sd3(now):
    months={now.strftime('%Y/%m'),(now.replace(day=1)-dt.timedelta(days=1)).strftime('%Y/%m')}
    latest={}
    ns={'s':'http://s3.amazonaws.com/doc/2006-03-01/'}
    for month in sorted(months):
        data,_=get(SD3+'?'+urllib.parse.urlencode({'list-type':'2','prefix':'typhoon-track/'+month+'/','max-keys':'1000'}))
        root=ET.fromstring(data)
        if root.findtext('s:IsTruncated',namespaces=ns)!='false':
            raise ValueError('Truncated SD3 catalogue; refusing incomplete discovery')
        for node in root.findall('s:Contents/s:Key',ns):
            key=node.text or ''
            m=re.fullmatch(r'typhoon-track/\d{4}/\d{2}/(\d{8})/(00|12)z/tc_([A-Z]+)_([A-Z0-9-]+)_track\.nc',key)
            if not m:
                continue
            date=dt.datetime.strptime(m[1]+m[2],'%Y%m%d%H').replace(tzinfo=UTC)
            if not dt.timedelta(0)<=now-date<=dt.timedelta(days=4):
                continue
            ident=(m[3],m[4])
            if ident not in latest or date>latest[ident][0]:
                latest[ident]=(date,key)
    tracks=[];failures=0
    for _,key in sorted(latest.values(),reverse=True)[:30]:
        try:
            data,_=get(SD3+key,4_000_000);tracks.append(parse_sd3(data,key))
        except Exception:
            failures+=1
    if not tracks:
        raise ValueError('No verifiable SD3 native tracks in last four days')
    return tracks,dict(model='SD3',status='partial' if failures else 'available',run='',message='各源系统采用目录中最近文件，可能早于其他模式；CC BY-NC 4.0，须署名且仅限非商业使用。')


def generate(now):
    try:
        previous=json.loads(get(PUBLISHED)[0])
        if previous.get('generator')!=VERSION:
            previous={}
    except Exception:
        previous={}
    tracks=[];models=[]
    for model,run in [('AIGFS',lambda:generate_aigfs(now,json.loads(get(PUBLIC)[0]))),('SD3',lambda:generate_sd3(now))]:
        try:
            rows,state=run()
        except Exception as error:
            rows=[dict(t,retained=True) for t in previous.get('tracks',[]) if t.get('model')==model]
            state=dict(model=model,status='retained' if rows else 'unavailable',run='',message=f'本次未能取得可验证来源（{type(error).__name__}）；'+('保留有日期的上次结果，不代表本次更新。' if rows else '无替代曲线。'))
            print(model, state['message'], str(error)[:240], flush=True)
        tracks.extend(rows);models.append(dict(state,checkedAt=iso(now)))
    if not tracks:
        raise ValueError('No usable native or derived tracks; refusing empty replacement')
    return dict(schema=1,generator=VERSION,checkedAt=iso(now),models=models,tracks=tracks)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',default='.generated-tracks/index.json');args=parser.parse_args()
    result=generate(dt.datetime.now(UTC));path=Path(args.output);path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(result,ensure_ascii=False,allow_nan=False,separators=(',',':'))+'\n')
    print('Published candidate',len(result['tracks']),'tracks;',path.stat().st_size,'bytes',flush=True)
