#!/usr/bin/env python3
"""Public NOAA/NCEP 31-member trackers and explicitly non-TC-classified field lows.

Native tracker VMAX (kt) is never adjusted. Field wind is kept in m/s, not
substituted into a tracker. No ensembles, cycles, storms or gaps are spliced.
Only compact JSON is published; downloaded GRIB messages stay in the runner.
"""
from __future__ import annotations
import argparse
import concurrent.futures
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
import re
import threading
import time
import urllib.error
import urllib.request

UTC = dt.timezone.utc
ROOT = 'https://nomads.ncep.noaa.gov/pub/data/nccf/com/ens_tracker/prod/'
GRID = 'https://nomads.ncep.noaa.gov/pub/data/nccf/com/aigefs/prod/'
VERSION = 'ncep-hybrid-v1'
HORIZONS = {'GEFS': 120, 'AIGEFS': 240}
METHOD = ('本站AIGEFS成员格点闭合L追踪，非NCEP气旋tracker或已判定热带系统。'
          '0.25°原生MSLP；出生限35°S–35°N、≤1012hPa，250km八方向闭合≥0.5hPa；'
          '6h间隔、移动≤510km，两候选距离差<75km或争用同一L即终止；至少2连续点。'
          '起报已存在的L不作新生；已被同成员原生tracker覆盖的路径不重复加入。'
          '风为中心250km内原生10m U/V向量模最大值(m/s)，非业务最大持续风、非气压推算。'
          '缺失格点即结束该成员，不跨缺口或混用起报。')
_lock = threading.Lock()
_next_request = 0.


def iso(value):
    return value.astimezone(UTC).isoformat(timespec='seconds').replace('+00:00', 'Z')


def parse_run(value):
    if not isinstance(value, str) or not re.fullmatch(r'20\d\d-\d\d-\d\dT(?:00|06|12|18):00:00Z', value):
        raise ValueError('An exact 00/06/12/18 UTC initialization is required')
    run = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if iso(run) != value:
        raise ValueError('Invalid initialization')
    return run


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('Unexpected NOAA source redirect')


_opener = urllib.request.build_opener(NoRedirect())


def get(url, limit=2_000_000, byte_range=None):
    global _next_request
    if not url.startswith((ROOT, GRID)) or '?' in url or '#' in url or '..' in url:
        raise ValueError('Unapproved NOAA source')
    # One shared public-service budget, including concurrent grid readers.
    with _lock:
        delay = max(0, _next_request-time.monotonic())
        if delay:
            time.sleep(delay)
        _next_request = time.monotonic()+.7
    headers = {'User-Agent': 'Bunn-ENS-NOAA-public-tracks/1.0'}
    if byte_range is not None:
        headers['Range'] = f'bytes={byte_range[0]}-{byte_range[1] if byte_range[1] is not None else ""}'
    with _opener.open(urllib.request.Request(url, headers=headers), timeout=45) as response:
        expected_length=None
        if byte_range is not None:
            match=re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)',response.headers.get('Content-Range',''))
            if response.status!=206 or not match:
                raise ValueError('Invalid exact NOAA byte range')
            start,end,total=map(int,match.groups())
            if start!=byte_range[0] or end!=(byte_range[1] if byte_range[1] is not None else total-1) or not start<=end<total:
                raise ValueError('Invalid exact NOAA byte range')
            expected_length=end-start+1
        data = response.read(limit+1)
        if len(data) > limit or expected_length is not None and len(data)!=expected_length:
            raise ValueError('Incomplete or oversized NOAA response')
        return data


def member_id(model, sample):
    if model not in HORIZONS or type(sample) is not int or not 0 <= sample <= 30:
        raise ValueError('Invalid NCEP member')
    return f'A{sample:03d}' if model == 'AIGEFS' else 'AC00' if sample == 0 else f'AP{sample:02d}'


def directory(model, run):
    return f'{ROOT}{model.lower()}.{run:%Y%m%d}/{run:%H}/'


def tracker_path(model, run, sample):
    return f'{directory(model, run)}tctrack/{member_id(model,sample).lower()}.t{run:%H}z.cyclone.trackatcfunix'


def genesis_path(run, sample):
    return f'{directory("GEFS",run)}genesis/storms.{member_id("GEFS",sample).lower()}.atcf_gen.altg.{run:%Y%m%d%H}'


def coordinate(value, latitude):
    match = re.fullmatch(r'(\d{1,4})([NS]$)' if latitude else r'(\d{1,5})([EW]$)', value)
    if not match:
        raise ValueError('Invalid native ATCF coordinate')
    n = int(match[1])/10 * (-1 if match[2] in ('S','W') else 1)
    if abs(n) > (90 if latitude else 360):
        raise ValueError('Invalid native ATCF coordinate range')
    return n if latitude else (n+180)%360-180


def scalar(value, low, high):
    try:
        n = int(value)
    except ValueError:
        raise ValueError('Invalid native tracker numeric field') from None
    if n <= 0 or n in (9999, -9999, -999):
        return None
    if not low <= n <= high:
        raise ValueError('Native tracker numeric range')
    return n


def parse_atcf(text, model, run, sample, genesis=False):
    """Keep only 34-kt-radius rows; these are not a VMAX>=34 filter."""
    if genesis and model != 'GEFS':
        raise ValueError('AIGEFS does not publish the GEFS genesis format')
    expected, rows, conflicts, native_keys = member_id(model,sample), {}, set(), {}
    for raw in text.splitlines():
        if not raw.strip():
            continue
        if len(raw) > 4096:
            raise ValueError('Oversized tracker row')
        a = [v.strip() for v in raw.split(',')]
        shift = 1 if genesis else 0
        if len(a) < 17+shift:
            raise ValueError('Short tracker row')
        # Genesis adds a native storm-token column before initialization.
        if a[2+shift] != run.strftime('%Y%m%d%H') or a[4+shift].upper() != expected:
            raise ValueError('Tracker cycle/member mismatch; refusing mixed source')
        if not re.fullmatch(r'\d{1,3}',a[5+shift]):
            raise ValueError('Invalid native lead')
        lead = int(a[5+shift])
        if lead > HORIZONS[model] or a[11+shift] != '34':
            continue
        if lead%6:
            raise ValueError('Unexpected tracker cadence')
        if genesis:
            identity = a[2]
            if a[0] not in ('TG','HC','AL','EP','CP','WP','IO','AA','BB','SH','SP','SI') or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',identity):
                raise ValueError('Invalid native genesis identity')
        else:
            if a[0] not in ('AL','EP','CP','WP','IO','AA','BB','SH','SP','SI') or not re.fullmatch(r'\d{1,2}',a[1]) or not 1 <= int(a[1]) <= 99:
                raise ValueError(f'Invalid native cyclone identity: {a[0]} {a[1]}')
            identity = f'{a[0]}{int(a[1]):02d}{run:%Y}'
        p = {'hour':lead,'lat':coordinate(a[6+shift],True),'lon':coordinate(a[7+shift],False),
             'windKt':scalar(a[8+shift],1,250),'pressureHpa':scalar(a[9+shift],800,1100),'windMs':None}
        native_keys[identity]=(a[0],a[1])
        key = (identity,lead)
        if key in rows and rows[key] != p:
            # Conflicting repeated quadrants never become an invented mean.
            conflicts.add(key)
        else:
            rows[key] = p
    tracks = {}
    for (identity,lead),p in rows.items():
        if (identity,lead) in conflicts:
            continue
        tracks.setdefault(identity,[]).append(p)
    return [{'sample':sample,'trackId':identity,'sourceId':identity,'nativeMember':expected,
             'nativeBasin':native_keys[identity][0],'nativeStormNumber':native_keys[identity][1],
             'kind':'genesis' if genesis else 'matched',
             'sourceFile':genesis_path(run,sample) if genesis else tracker_path(model,run,sample),
             'method':'NCEP原生genesis候选tracker，保留原始类别与编号，不自动判为热带系统，非本站格点追踪' if genesis else 'NCEP原生已编号系统tracker；34kt半径行去重，VMAX原值kt',
             'points':sorted(points,key=lambda p:p['hour'])} for identity,points in sorted(tracks.items())]


def distance(a,b):
    r=math.pi/180
    h=math.sin((b['lat']-a['lat'])*r/2)**2+math.cos(a['lat']*r)*math.cos(b['lat']*r)*math.sin((b['lon']-a['lon'])*r/2)**2
    return 12742.0176*math.asin(min(1,math.sqrt(h)))


def duplicate_of_native(track, native):
    for candidate in native:
        if candidate['sample'] != track['sample'] or candidate['kind'] != 'matched':
            continue
        same={p['hour']:p for p in candidate['points']}
        pairs=[(p,same[p['hour']]) for p in track['points'] if p['hour'] in same]
        if len(pairs)>=2 and pairs[-1][0]['hour']-pairs[0][0]['hour']>=6 and all(distance(a,b)<=100 for a,b in pairs):
            return candidate['trackId']
    return None


def discover(model, now=None):
    now = now or dt.datetime.now(UTC)
    day = now.replace(hour=0,minute=0,second=0,microsecond=0)
    for d in (day,day-dt.timedelta(days=1)):
        try:
            listing = get(f'{ROOT}{model.lower()}.{d:%Y%m%d}/',100_000).decode()
        except (urllib.error.HTTPError,TimeoutError):
            continue
        for hour in (18,12,6,0):
            run=d.replace(hour=hour)
            if run>now or f'href="{hour:02d}/"' not in listing:
                continue
            try:
                files=get(directory(model,run)+'tctrack/',200_000).decode()
                if all(tracker_path(model,run,m).rsplit('/',1)[1] in files for m in range(31)):
                    return run
            except (urllib.error.HTTPError,TimeoutError):
                continue
    raise ValueError(f'No published complete 31-member {model} tracker listing')


def native_dataset(model,run):
    tracks, members, failures = [], [], []
    def one(sample):
        path=tracker_path(model,run,sample)
        native=parse_atcf(get(path,2_000_000).decode(),model,run,sample)
        gen,warning=[],''
        if model=='GEFS':
            try:
                gen=parse_atcf(get(genesis_path(run,sample),4_000_000).decode(),model,run,sample,True)
            except Exception as error:
                warning=f'genesis unavailable ({type(error).__name__}: {str(error)[:100]}); no derived substitute'
        retained=[]
        duplicates=0
        for t in gen:
            if duplicate_of_native(t,native):
                duplicates+=1
            else:
                retained.append(t)
        return native+retained,{'sample':sample,'nativeId':member_id(model,sample),'type':'control' if sample==0 else 'perturbed',
                                'tracker':'available','genesis':'available' if model=='GEFS' and not warning else 'unavailable' if warning else 'not_published',
                                'duplicateGenesisOmitted':duplicates},warning
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        jobs={pool.submit(one,m):m for m in range(31)}
        for job in concurrent.futures.as_completed(jobs):
            sample=jobs[job]
            try:
                rows,member,warning=job.result()
                tracks.extend(rows);members.append(member)
                if warning:
                    failures.append({'sample':sample,'stage':'genesis','reason':warning})
            except Exception as error:
                members.append({'sample':sample,'nativeId':member_id(model,sample),'type':'control' if sample==0 else 'perturbed',
                                'tracker':'unavailable','genesis':'unavailable' if model=='GEFS' else 'not_published','duplicateGenesisOmitted':0})
                failures.append({'sample':sample,'stage':'tracker','reason':type(error).__name__})
    if not tracks:
        raise ValueError('No verified native tracks; refusing empty replacement')
    return {'schema':1,'generator':VERSION,'model':model,'run':iso(run),'checkedAt':iso(dt.datetime.now(UTC)),
            'horizonHours':HORIZONS[model],'ensembleSize':31,'windUnit':'kt','fieldWindUnit':'m/s','pressureUnit':'hPa',
            'source':directory(model,run),'members':sorted(members,key=lambda m:m['sample']),
            'tracks':sorted(tracks,key=lambda t:(t['kind'],t['sample'],t['trackId'])), 'failures':failures,
            'derived':{'status':'pending' if model=='AIGEFS' else 'not_needed','fields':0,'method':METHOD if model=='AIGEFS' else 'GEFS使用NCEP原生genesis tracker；不需要以场L替代。'}}


def field_ranges(index,run,sample,hour):
    records=[]
    for line in index.splitlines():
        a=line.split(':')
        if len(a)<6 or not a[1].isdigit():
            raise ValueError('Invalid native GRIB index')
        if a[2]!=f'd={run:%Y%m%d%H}' or not re.search(rf'P-ENS={sample}(?:\s|:|$)',line):
            raise ValueError('GRIB index cycle/member mismatch')
        expected='anl' if hour==0 else f'{hour} hour fcst'
        records.append((int(a[1]),a[3],a[4],a[5],line))
        if a[3] in ('PRMSL','UGRD','VGRD') and a[5]!=expected:
            raise ValueError('GRIB index lead mismatch')
    found={}
    for i,(start,name,level,_,_) in enumerate(records):
        wanted=(name=='PRMSL' and level=='mean sea level') or (name in ('UGRD','VGRD') and level=='10 m above ground')
        if wanted:
            if name in found:
                raise ValueError('Ambiguous native GRIB field')
            # Analysis has no precipitation record: PRMSL is the final message.
            # Its open-ended range is verified against the HTTP total and exact
            # GRIB message length, never treated as absent or implicit zeros.
            found[name]=(start,records[i+1][0]-1 if i+1<len(records) else None)
    if set(found)!={'PRMSL','UGRD','VGRD'}:
        raise ValueError('Missing pressure or native 10m wind field')
    return found


def read_grib(data,run,sample,hour,key):
    import eccodes as ec
    import numpy as np
    handle=ec.codes_new_from_message(data)
    try:
        getv=lambda name:ec.codes_get(handle,name)
        if (int(getv('dataDate'))!=int(run.strftime('%Y%m%d')) or int(getv('dataTime'))!=run.hour*100
            or int(getv('endStep'))!=hour or int(getv('perturbationNumber'))!=sample
            or getv('stepType')!='instant' or getv('gridType')!='regular_ll'):
            raise ValueError('Native GRIB run/member/lead/statistic/grid mismatch')
        valid=run+dt.timedelta(hours=hour)
        if getv('stepUnits') not in (1,'h') or int(getv('validityDate'))!=int(valid.strftime('%Y%m%d')) or int(getv('validityTime'))!=valid.hour*100 or ec.codes_get_message_size(handle)!=len(data):
            raise ValueError('Native GRIB valid UTC/time unit/message length mismatch')
        expected={'PRMSL':('meanSea',0,{'Pa'}),'UGRD':('heightAboveGround',10,{'m s**-1'}),'VGRD':('heightAboveGround',10,{'m s**-1'})}[key]
        if getv('typeOfLevel')!=expected[0] or int(getv('level'))!=expected[1] or getv('units') not in expected[2]:
            raise ValueError('Native GRIB level/unit mismatch')
        short={'PRMSL':{'prmsl','msl'},'UGRD':{'10u'},'VGRD':{'10v'}}[key]
        if getv('shortName') not in short:
            raise ValueError('Wrong native physical variable')
        ni,nj=int(getv('Ni')),int(getv('Nj'))
        if (ni,nj) not in ((1440,721),(1440,720)):
            raise ValueError('Unexpected native 0.25 degree grid')
        values=np.array(ec.codes_get_values(handle),dtype=float).reshape(nj,ni)
        lats=np.array(ec.codes_get_array(handle,'latitudes')).reshape(nj,ni)
        lons=np.array(ec.codes_get_array(handle,'longitudes')).reshape(nj,ni)
        if ec.codes_get(handle,'bitmapPresent'):
            values=np.where(values==float(getv('missingValue')),np.nan,values)
        if not np.allclose(np.abs(np.diff(lats[:,0])),.25) or not np.allclose(np.diff(lons[0]),.25) or not np.allclose(lats,lats[:,0,None]) or not np.allclose(lons,lons[0,None,:]):
            raise ValueError('Native coordinates do not match grid spacing')
        if key=='PRMSL':
            values=values/100 # Published grid pressure only. Never changes tracker MSLP.
        return values,lats[:,0],lons[0]
    finally:
        ec.codes_release(handle)


def grid_fields(run,sample,hour,cache):
    folder=Path(cache)/f'{run:%Y%m%d%H}'/f'm{sample:03d}'
    folder.mkdir(parents=True,exist_ok=True)
    base=f'{GRID}aigefs.{run:%Y%m%d}/{run:%H}/mem{sample:03d}/model/atmos/grib2/aigefs.t{run:%H}z.sfc.f{hour:03d}.grib2'
    idx_path=folder/f'{hour:03d}.idx'
    if not idx_path.exists():
        idx_path.write_bytes(get(base+'.idx',50_000))
    ranges=field_ranges(idx_path.read_text(),run,sample,hour)
    fields={}
    for key,bounds in ranges.items():
        path=folder/f'{hour:03d}-{key}.grib2'
        if not path.exists():
            path.write_bytes(get(base,5_000_000,bounds))
        fields[key]=read_grib(path.read_bytes(),run,sample,hour,key)
    import numpy as np
    p,lat,lon=fields['PRMSL']
    for key in ('UGRD','VGRD'):
        if not np.array_equal(fields[key][1],lat) or not np.array_equal(fields[key][2],lon):
            raise ValueError('Native wind and pressure grids differ')
    return p,np.hypot(fields['UGRD'][0],fields['VGRD'][0]),lat,lon


def closed_lows(pressure,wind,lats,lons,hour):
    import numpy as np
    from scipy.ndimage import minimum_filter
    finite=np.isfinite(pressure)
    field=np.where(finite,pressure,np.inf)
    minimum=minimum_filter(field,size=5,mode=('nearest','wrap'))
    indices=np.argwhere((field==minimum)&(field<=1012)&(np.abs(lats[:,None])<=45))
    candidates=[]
    dy=abs(float(lats[1]-lats[0]))
    for iy,ix in sorted(indices,key=lambda q:field[q[0],q[1]]):
        lat,lon=float(lats[iy]),float(lons[ix])
        # Reject plateaus, incomplete rings and small unclosed troughs.
        local=field[max(0,iy-1):iy+2][:,[(ix-1)%len(lons),ix,(ix+1)%len(lons)]]
        if np.count_nonzero(local==field[iy,ix])!=1:
            continue
        ring=[]
        for bearing in range(0,360,45):
            a=math.radians(bearing)
            ry=int(round(iy-250/111.2*math.cos(a)/dy)) if lats[1]<lats[0] else int(round(iy+250/111.2*math.cos(a)/dy))
            rx=int(round(ix+250/(111.2*max(.1,math.cos(math.radians(lat))))*math.sin(a)/.25))%len(lons)
            if not 0<=ry<len(lats):
                break
            ring.append(pressure[ry,rx])
        if len(ring)!=8 or not all(math.isfinite(float(v)) for v in ring) or min(ring)-field[iy,ix]<.5:
            continue
        p={'hour':hour,'lat':lat,'lon':(lon+180)%360-180,'windKt':None,'pressureHpa':float(field[iy,ix]),'windMs':None}
        if any(distance(p,q)<300 for q in candidates):
            continue
        # Actual vector speed sampled around this L; not a pressure-wind relation.
        yr=max(1,int(math.ceil(250/111.2/dy)))
        xr=max(1,int(math.ceil(250/(111.2*max(.1,math.cos(math.radians(lat))))/.25)))
        ys=np.arange(max(0,iy-yr),min(len(lats),iy+yr+1));xs=np.arange(ix-xr,ix+xr+1)%len(lons)
        dlat=np.radians(lats[ys,None]-lat);dlon=np.radians((lons[xs][None,:]-lon+180)%360-180)
        dist=12742.0176*np.arcsin(np.minimum(1,np.sqrt(np.sin(dlat/2)**2+np.cos(np.radians(lat))*np.cos(np.radians(lats[ys,None]))*np.sin(dlon/2)**2)))
        sampled=wind[np.ix_(ys,xs)][dist<=250]
        if sampled.size and np.all(np.isfinite(sampled)):
            p['windMs']=float(np.max(sampled))
        candidates.append(p)
    return sorted(candidates,key=lambda p:(p['pressureHpa'],p['lat'],p['lon']))


def advance_lows(active,candidates,run,sample,hour):
    """Direct one-step matches only. Never reconnect a stopped or ambiguous L."""
    choices={}
    for i,track in enumerate(active):
        previous=track['points'][-1]
        if previous['hour']!=hour-6:
            continue
        nearest=sorted([(distance(previous,p),j) for j,p in enumerate(candidates) if distance(previous,p)<=510])
        if nearest and (len(nearest)==1 or nearest[1][0]-nearest[0][0]>=75):
            choices[i]=nearest[0][1]
    used=set(choices.values())
    contested={j for j in used if list(choices.values()).count(j)>1}
    next_active=[]
    ended=[]
    for i,track in enumerate(active):
        j=choices.get(i)
        if j is None or j in contested:
            track['endReason']='低压消失／不闭合／候选歧义或多路径争用，停止，不补点。'
            ended.append(track)
        else:
            track['points'].append(candidates[j]);next_active.append(track)
    # A disputed candidate cannot be relabelled as a fresh birth in the same step.
    near_old={j for j,p in enumerate(candidates) if any(distance(t['points'][-1],p)<=510 for t in active)}
    for j,p in enumerate(candidates):
        if j in used or j in near_old or hour>0 and abs(p['lat'])>35:
            continue
        token=f'L_AIGEFS_{run:%Y%m%d%H}_M{sample:03d}_F{hour:03d}_{p["lat"]:.2f}_{p["lon"]:.2f}'
        next_active.append({'sample':sample,'trackId':token,'sourceId':token,'nativeMember':member_id('AIGEFS',sample),
                            'kind':'derived_low','sourceFile':f'{GRID}aigefs.{run:%Y%m%d}/{run:%H}/mem{sample:03d}/',
                            'method':'local-field-l-v1','baseline':hour==0,'points':[p]})
    return next_active,ended


def derived_member(run,sample,cache):
    active,ended,fields=[],[],0
    failure=''
    for hour in range(0,241,6):
        try:
            pressure,wind,lats,lons=grid_fields(run,sample,hour,cache)
            candidates=closed_lows(pressure,wind,lats,lons,hour)
            active,stopped=advance_lows(active,candidates,run,sample,hour)
            ended.extend(stopped);fields+=1
        except Exception as error:
            failure=f'+{hour}h {type(error).__name__}: {str(error)[:160]}; member stopped, no later birth or continuation'
            break
    ended.extend(active)
    result=[]
    for track in ended:
        if not track.pop('baseline') and len(track['points'])>=2:
            track.setdefault('endReason','到达实际可用格点终点；不代表此后消失。' if not failure else failure)
            result.append(track)
    return result,fields,failure


def member_checkpoint(folder,run,sample,value=None):
    """Compact verified tracks only; never save GRIB or authentication material."""
    folder=Path(folder);path=folder/f'{run:%Y%m%dT%H%M%SZ}-M{sample:03d}.json'
    fingerprint=hashlib.sha256(METHOD.encode()).hexdigest()
    if value is not None:
        tracks,count,error=value
        payload={'schema':1,'generator':VERSION,'model':'AIGEFS','run':iso(run),'sample':sample,
                 'methodSha256':fingerprint,'fields':count,'error':error,'tracks':tracks}
        folder.mkdir(parents=True,exist_ok=True)
        temporary=path.with_suffix('.tmp');temporary.write_text(json.dumps(payload,ensure_ascii=False,separators=(',',':'),allow_nan=False)+'\n');temporary.replace(path)
        return value
    if not path.is_file():
        return None
    if path.stat().st_size>2_000_000:
        raise ValueError('Member checkpoint exceeds bounded compact budget')
    data=json.loads(path.read_text())
    if (data.get('schema')!=1 or data.get('generator')!=VERSION or data.get('model')!='AIGEFS'
        or data.get('run')!=iso(run) or type(data.get('sample')) is not int or data.get('sample')!=sample or data.get('methodSha256')!=fingerprint
        or data.get('fields')!=41 or data.get('error') or not isinstance(data.get('tracks'),list) or len(data['tracks'])>1500):
        return None  # incomplete/different runs are recomputed from +0h, never joined
    for track in data['tracks']:
        prefix=f'L_AIGEFS_{run:%Y%m%d%H}_M{sample:03d}_F'
        if (track.get('kind')!='derived_low' or type(track.get('sample')) is not int or track.get('sample')!=sample or track.get('nativeMember')!=member_id('AIGEFS',sample)
            or not track.get('trackId','').startswith(prefix) or track.get('sourceId')!=track['trackId']
            or track.get('sourceFile')!=f'{GRID}aigefs.{run:%Y%m%d}/{run:%H}/mem{sample:03d}/'
            or track.get('method')!='local-field-l-v1' or not 2<=len(track.get('points',[]))<=41):
            raise ValueError('Unverified member checkpoint identity/method')
        previous=None
        for point in track['points']:
            hour=point.get('hour')
            if type(hour) is not int or not 0<=hour<=240 or hour%6 or previous is not None and hour!=previous+6:
                raise ValueError('Member checkpoint has a time gap or wrong lead')
            previous=hour
            for key,low,high,nullable in [('lat',-45,45,False),('lon',-180,180,False),('pressureHpa',800,1100,False),('windMs',0,200,True)]:
                v=point.get(key)
                if nullable and v is None:continue
                if type(v) not in (int,float) or not math.isfinite(v) or not low<=v<=high:
                    raise ValueError('Member checkpoint has invalid native point')
            if point.get('windKt') is not None:
                raise ValueError('Field speed cannot become tracker VMAX')
        first=track['points'][0]
        expected=f'{prefix}{first["hour"]:03d}_{first["lat"]:.2f}_{first["lon"]:.2f}'
        if first['hour']==0 or abs(first['lat'])>35 or track['trackId']!=expected:
            raise ValueError('Checkpoint birth is not the verified source field identity')
    return data['tracks'],41,''


def hybrid_dataset(payload,cache,checkpoint_dir=None,resume=False):
    if payload['model']!='AIGEFS':
        return payload
    run=parse_run(payload['run'])
    derived,counts,failures=[],[],[]
    native=[t for t in payload['tracks'] if t['kind']!='derived_low']
    omitted=0
    def run_member(sample):
        if resume and checkpoint_dir:
            cached=member_checkpoint(checkpoint_dir,run,sample)
            if cached is not None:
                print(f'AIGEFS member {sample:03d}: reusing complete same-run verified compact checkpoint; no grid reread',flush=True)
                return cached
        value=derived_member(run,sample,cache)
        if checkpoint_dir:
            member_checkpoint(checkpoint_dir,run,sample,value)
        return value
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        jobs={pool.submit(run_member,m):m for m in range(31)}
        for job in concurrent.futures.as_completed(jobs):
            m=jobs[job]
            tracks,count,error=job.result();counts.append(count)
            for track in tracks:
                if duplicate_of_native(track,native):
                    omitted+=1
                else:
                    derived.append(track)
            if error:
                failures.append({'sample':m,'stage':'gridded','reason':error})
            print(f'AIGEFS member {m:03d}: verified {count}/41 native fields; {len(tracks)} new closed-L tracks'+(' (partial)' if error else ''),flush=True)
    payload={**payload,'checkedAt':iso(dt.datetime.now(UTC)),'tracks':sorted(native+derived,key=lambda t:(t['kind'],t['sample'],t['trackId'])),
             'failures':[f for f in payload['failures'] if f['stage']!='gridded']+failures,
             'derived':{'status':'available' if all(n==41 for n in counts) else 'partial' if any(n>1 for n in counts) else 'unavailable',
                        'fields':sum(counts),'expectedFields':31*41,'membersComplete':sum(n==41 for n in counts),
                        'duplicateFieldTracksOmitted':omitted,'method':METHOD}}
    return payload


def write_dataset(payload,out):
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    model=payload['model'];key=f'{model}-{payload["run"].replace("-","").replace(":","")}.json'
    encoded=json.dumps(payload,ensure_ascii=False,separators=(',',':'),allow_nan=False)+'\n'
    if len(encoded.encode())>16_000_000:
        raise ValueError('Compact public track budget exceeded')
    (out/key).write_text(encoded)
    (out/f'{model}.json').write_text(encoded)
    print(f'{model}: {len(payload["tracks"])} real tracks, 31 declared members, {payload["run"]}; field lows {payload["derived"]["status"]}',flush=True)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--models',nargs='+',choices=list(HORIZONS),default=list(HORIZONS))
    parser.add_argument('--run',default='latest')
    parser.add_argument('--out',default='.generated-ensembles')
    parser.add_argument('--cache',default='.ncep-grid-cache')
    parser.add_argument('--tracker-only',action='store_true')
    parser.add_argument('--hybrid-existing',action='store_true')
    parser.add_argument('--resume-members',action='store_true',help='Reuse only explicitly restored complete, same-run compact checkpoints')
    args=parser.parse_args()
    for model in args.models:
        if args.hybrid_existing:
            payload=json.loads((Path(args.out)/f'{model}.json').read_text())
        else:
            run=discover(model) if args.run=='latest' else parse_run(args.run)
            payload=native_dataset(model,run)
        if not args.tracker_only:
            payload=hybrid_dataset(payload,args.cache,Path(args.out)/'field-members',args.resume_members)
        write_dataset(payload,args.out)


if __name__=='__main__':
    main()
