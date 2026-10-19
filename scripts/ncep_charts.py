#!/usr/bin/env python3
"""Render published NCEP member tracks to real PNG/SVG in GitHub Actions.

No private API, browser GRIB reads, fabricated continuations or all-storm mean.
Each numbered storm gets its own conditional >=8/31 member mean. Genesis and
field-L paths stay distinct and unclassified; field wind is never tracker VMAX.
"""
import argparse
import csv
import datetime as dt
import hashlib
import gzip
import io
import json
import math
from pathlib import Path
import shutil
import re
import urllib.request

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.collections import LineCollection
from matplotlib.lines import Line2D
import numpy as np

try:
    from ncep_ensembles import HORIZONS, member_id, parse_run
    from wm6_forecast import add_geography
except ImportError: # Importable by unittest from the repository root.
    from scripts.ncep_ensembles import HORIZONS, member_id, parse_run
    from scripts.wm6_forecast import add_geography

PUBLIC='https://raw.githubusercontent.com/BunnHack/bunn-ens/ensemble-track-data/'
VERSION='ncep-charts-v3-png'
REGIONS=[
    {'id':'world','label':'Global','bounds':[-180,180,-55,60]},
    {'id':'wp','label':'Western Pacific','bounds':[100,210,0,55]},
    {'id':'ep','label':'Eastern Pacific','bounds':[-180,-75,0,50]},
    {'id':'al','label':'Atlantic','bounds':[-100,20,0,60]},
    {'id':'ni','label':'North Indian Ocean','bounds':[40,110,-5,40]},
    {'id':'si','label':'South Indian Ocean','bounds':[20,140,-50,0]},
    {'id':'sp','label':'South Pacific','bounds':[135,250,-50,0]},
]
# Exact existing application bins/colours; no changes to tracker wind values.
CATEGORIES=[(137,'C5','#ef50ef'),(113,'C4','#800000'),(96,'C3','#ff0000'),(83,'C2','#ff8000'),
            (64,'C1','#f4d500'),(34,'TS','#00aaff'),(25,'Depression','#009e00'),(0,'Disturbance','#00e617')]


def wind_color(value):
    if value is None or not math.isfinite(value):
        return '#7b8798'
    return next((color for minimum,_,color in CATEGORIES if value>=minimum),'#7b8798')


def validate(payload,model):
    run=parse_run(payload['run'])
    if payload.get('schema')!=1 or payload.get('generator')!='ncep-hybrid-v1' or payload.get('model')!=model or payload.get('ensembleSize')!=31 or payload.get('horizonHours')!=HORIZONS[model] or payload.get('windUnit')!='kt' or payload.get('fieldWindUnit')!='m/s' or payload.get('pressureUnit')!='hPa':
        raise ValueError('Native model/member/unit identity mismatch')
    if len(payload['members'])!=31 or {m['sample'] for m in payload['members']}!=set(range(31)) or any(m['nativeId']!=member_id(model,m['sample']) for m in payload['members']):
        raise ValueError('Native 31-member inventory missing')
    if not payload['tracks']:
        raise ValueError('No real tracks; refusing empty chart replacement')
    for t in payload['tracks']:
        if t['sample'] not in range(31) or t['nativeMember']!=member_id(model,t['sample']) or t['kind'] not in ('matched','genesis','derived_low') or t['trackId']!=t['sourceId']:
            raise ValueError('Native trajectory identity mismatch')
        if t['kind']=='matched' and not re.fullmatch(r'(?:AL|EP|CP|WP|IO|AA|BB|SH|SP|SI)(?:0[1-9]|[1-9]\d)20\d{2}',t['trackId']):
            raise ValueError('Unsafe native numbered-storm asset identity')
        hours=[p['hour'] for p in t['points']]
        if not hours or hours!=sorted(set(hours)) or any(type(h) is not int or h%6 or not 0<=h<=HORIZONS[model] for h in hours):
            raise ValueError('Native lead range/cadence mismatch')
        if t['kind']=='derived_low' and (model!='AIGEFS' or hours[0]==0 or len(hours)<2 or any(b-a!=6 for a,b in zip(hours,hours[1:]))):
            raise ValueError('Field L requires an actual consecutive post-initialization sequence')
        for p in t['points']:
            if not all(isinstance(p[k],(int,float)) and math.isfinite(p[k]) for k in ('lat','lon')) or abs(p['lat'])>90 or abs(p['lon'])>180:
                raise ValueError('Invalid native location')
            if t['kind']=='derived_low' and p['windKt'] is not None or t['kind']!='derived_low' and p['windMs'] is not None:
                raise ValueError('Tracker VMAX and native field wind cannot be substituted')
    return run


def read_publication(model,source=None,data_ref='ensemble-track-data'):
    if data_ref!='ensemble-track-data' and not re.fullmatch(r'[0-9a-f]{40}',data_ref):
        raise ValueError('Only the fixed public data branch or an exact commit is accepted')
    public=PUBLIC.replace('ensemble-track-data/',data_ref+'/')
    if source:
        data=Path(source).read_bytes()
    else:
        request=urllib.request.Request(public+model+'.json',headers={'User-Agent':'Bunn-ENS-public-chart-generator/1.0'})
        with urllib.request.urlopen(request,timeout=45) as response:
            if response.geturl()!=public+model+'.json':
                raise ValueError('Unexpected publication redirect')
            data=response.read(16_000_001)
    if len(data)>16_000_000:
        raise ValueError('Compact publication budget')
    payload=json.loads(data)
    validate(payload,model)
    return payload,hashlib.sha256(data).hexdigest()


def conditional_mean(tracks,field=None):
    """One original trajectory/member for ONE native numbered storm, >=8/31."""
    if not tracks or len({t['trackId'] for t in tracks})!=1 or any(t['kind']!='matched' for t in tracks):
        return []
    buckets={}
    for track in tracks:
        for point in track['points']:
            if field and (point[field] is None or not math.isfinite(point[field])):
                continue
            at=buckets.setdefault(point['hour'],{})
            sample=track['sample']
            if sample in at and at[sample]!=point:
                at[sample]=None
            elif sample not in at:
                at[sample]=point
    result=[]
    for hour,members in sorted(buckets.items()):
        points=[p for p in members.values() if p is not None]
        if len(points)<8:
            continue
        p={'hour':hour,'count':len(points),'lat':sum(p['lat'] for p in points)/len(points),
           'lon':math.degrees(math.atan2(sum(math.sin(math.radians(p['lon'])) for p in points),sum(math.cos(math.radians(p['lon'])) for p in points)))}
        if field:
            values=[p[field] for p in points]
            p.update(value=sum(values)/len(values),minimum=min(values),maximum=max(values))
        result.append(p)
    return result


def segments(points,west,east,field=None,max_gap=12):
    center=(west+east)/2
    x=lambda p:center+(p['lon']-center+180)%360-180
    result=[]
    for before,point in zip(points,points[1:]):
        if 0<point['hour']-before['hour']<=max_gap and abs(x(point)-x(before))<180 and (field is None or before.get(field) is not None and point.get(field) is not None):
            result.append((before,point,[(x(before),before['lat']),(x(point),point['lat'])]))
    return result


def provenance(payload):
    members=sum(m['tracker']=='available' for m in payload['members'])
    if payload['model']=='GEFS':
        extra=f"native genesis {sum(m['genesis']=='available' for m in payload['members'])}/31"
    else:
        d=payload['derived'];extra=f"field-L {d['status']} ({d['fields']}/1271 verified member-hours)"
    return f"NCEP/NOAA | 31 declared members (control 0 + 1-30); tracker files {members}/31 | {extra}"


def save(fig,destination):
    destination.parent.mkdir(parents=True,exist_ok=True)
    fig.savefig(destination.with_suffix('.png'),dpi=160,facecolor=fig.get_facecolor())
    # Workflow graphics are PNG only. Do not generate or publish SVG/SVGZ.
    destination.with_suffix('.svg').unlink(missing_ok=True)
    plt.close(fig)
    return {'png':str(destination.with_suffix('.png'))}


def chart_footer(fig,payload,extra):
    fig.text(.055,.044,provenance(payload),fontsize=8,color='#42586e')
    fig.text(.055,.025,extra,fontsize=8,color='#42586e')
    fig.text(.055,.008,f"Run {payload['run']} | Source publication checked {payload['checkedAt']} | Local chart; not an official warning",fontsize=7.5,color='#42586e')


def map_chart(payload,region,destination,storm=None):
    west,east,south,north=region['bounds']
    tracks=[t for t in payload['tracks'] if storm is None or t['kind']=='matched' and t['trackId']==storm]
    fig,ax=plt.subplots(figsize=(12.5,8.125));fig.subplots_adjust(left=.065,right=.98,top=.88,bottom=.13)
    fig.patch.set_facecolor('white');ax.set_facecolor('#edfaff')
    add_geography(ax,region)
    ax.set(xlim=(west,east),ylim=(south,north),xlabel='Longitude',ylabel='Latitude')
    ax.grid(color='#b8cbd4',linewidth=.5)
    center=(west+east)/2
    x=lambda p:center+(p['lon']-center+180)%360-180
    visible=0
    for track in tracks:
        points=track['points'];kind=track['kind']
        in_view=[p for p in points if west<=x(p)<=east and south<=p['lat']<=north]
        if in_view:visible+=1
        pieces=segments(points,west,east,max_gap=6 if kind=='derived_low' else 12)
        color='#6b747c' if kind=='derived_low' else '#567ea0' if kind=='genesis' else None
        if pieces:
            ax.add_collection(LineCollection([s[2] for s in pieces],colors=[color or wind_color(s[1]['windKt']) for s in pieces],linewidths=.65 if kind!='matched' else 1.0,alpha=.36 if kind!='matched' else .55,zorder=3))
        if in_view:
            ax.scatter([x(p) for p in in_view],[p['lat'] for p in in_view],s=7 if kind=='matched' else 4,c=[color or wind_color(p['windKt']) for p in in_view],alpha=.6,linewidths=0,zorder=4)
        if storm and track['sample']==0:
            ax.add_collection(LineCollection([s[2] for s in pieces],colors='#111820',linewidths=1.6,zorder=6))
    identities=sorted({t['trackId'] for t in tracks if t['kind']=='matched'})
    mean_count=0
    for identity in identities:
        selected=[t for t in tracks if t['kind']=='matched' and t['trackId']==identity]
        mean=conditional_mean(selected);pieces=segments(mean,west,east)
        mean_color='#137c8b' if payload['model']=='GEFS' else '#a3401e'
        if pieces:
            ax.add_collection(LineCollection([s[2] for s in pieces],colors=mean_color,linewidths=2.4,zorder=7))
            if any(west<=x(p)<=east and south<=p['lat']<=north for p in mean):mean_count+=1
        label_used=[]
        for p in mean:
            if p['hour']%48 or not west<x(p)<east or not south<p['lat']<north:continue
            if any(abs(x(p)-a)<(east-west)*.09 and abs(p['lat']-b)<(north-south)*.045 for a,b in label_used):continue
            label_used.append((x(p),p['lat']))
            ax.text(x(p)+.4,p['lat']+.4,f"+{p['hour']}h",fontsize=7,color=mean_color,zorder=9,bbox={'facecolor':'#eef5fa','alpha':.7,'edgecolor':'none','pad':1})
        if mean and not storm:
            end=mean[-1]
            if west<x(end)<east and south<end['lat']<north:
                ax.text(x(end),end['lat'],identity,fontsize=8,color=mean_color,zorder=9)
    title=f"{payload['model']} | {storm or region['label']} | +0-{payload['horizonHours']}h"
    fig.suptitle(title,x=.055,y=.975,ha='left',fontsize=17,color='#284c71')
    fig.text(.055,.925,f"Initialization {payload['run']} | {visible} source trajectories with a fix in view | Native kt / hPa unchanged",fontsize=9,color='#42586e')
    handles=[Line2D([],[],color='#137c8b' if payload['model']=='GEFS' else '#a3401e',linewidth=2.4,label='Separate storm means (>=8/31 positions)'),Line2D([],[],color='#111820',linewidth=1.5,label='Control member 0' if storm else 'Native numbered-system members'),Line2D([],[],color='#567ea0',linewidth=1,label='Native genesis candidates (not classified TC)'),Line2D([],[],color='#6b747c',linewidth=1,label='Derived field L (not classified TC)')]
    ax.legend(handles=handles,loc='upper left',fontsize=7,framealpha=.85)
    chart_footer(fig,payload,'No cone/landfall markers. No line across >12h; field-L uses consecutive 6h fixes. No mean of unrelated storms. Natural Earth 1:50m.')
    save(fig,destination)
    return {'trajectoryCount':visible,'separateStormMeans':mean_count}


def intensity_chart(payload,storm,field,destination):
    tracks=[t for t in payload['tracks'] if t['kind']=='matched' and t['trackId']==storm]
    mean=conditional_mean(tracks,field)
    fig,ax=plt.subplots(figsize=(12.5,7.5));fig.subplots_adjust(left=.075,right=.98,top=.87,bottom=.13)
    fig.patch.set_facecolor('#f5f8fb');ax.set_facecolor('#f5f8fb')
    if field=='windKt':
        bands=list(reversed(CATEGORIES))
        for i,(lower,_,color) in enumerate(bands):
            upper=bands[i+1][0] if i+1<len(bands) else 250
            ax.axhspan(lower,upper,color=color,alpha=.12,zorder=0)
    def line(points,color,width,alpha=1):
        pairs=[(a,b) for a,b in zip(points,points[1:]) if 0<b['hour']-a['hour']<=12 and a.get(field) is not None and b.get(field) is not None]
        if pairs:ax.add_collection(LineCollection([[(a['hour'],a[field]),(b['hour'],b[field])] for a,b in pairs],colors=color,linewidths=width,alpha=alpha,zorder=3))
        good=[p for p in points if p.get(field) is not None]
        ax.scatter([p['hour'] for p in good],[p[field] for p in good],s=5 if width<2 else 17,c=color,alpha=alpha,zorder=4)
    for t in tracks:line(t['points'],'#141f29' if t['sample']==0 else '#6c7f90',1.35 if t['sample']==0 else .55,1 if t['sample']==0 else .3)
    mean_points=[{**p,field:p['value']} for p in mean]
    color='#137c8b' if payload['model']=='GEFS' else '#a3401e'
    line(mean_points,color,2.6)
    values=[p[field] for t in tracks for p in t['points'] if p[field] is not None]
    ax.set_xlim(0,payload['horizonHours']);ax.set_xticks(np.arange(0,payload['horizonHours']+1,24))
    ax.set_xlabel('Native forecast lead (+h); valid UTC = initialization + lead')
    if values:
        lower,upper=min(values),max(values);padding=max(5,(upper-lower)*.08)
        ax.set_ylim(max(0,lower-padding) if field=='windKt' else lower-padding,upper+padding)
    if field=='pressureHpa':ax.invert_yaxis()
    ax.set_ylabel('Native tracker VMAX (kt)' if field=='windKt' else 'Native tracker minimum MSLP (hPa)')
    ax.grid(color='#b8cbd4',linewidth=.5)
    handles=[]
    if mean:handles.append(Line2D([],[],color=color,linewidth=2.6,label='Conditional mean: >=8 / declared 31 members'))
    if any(t['sample']==0 and any(p[field] is not None for p in t['points']) for t in tracks):handles.append(Line2D([],[],color='#141f29',linewidth=1.35,label='Control 0'))
    if any(t['sample']>0 and any(p[field] is not None for p in t['points']) for t in tracks):handles.append(Line2D([],[],color='#6c7f90',linewidth=.55,label='Perturbed members 1-30'))
    if handles:ax.legend(handles=handles,fontsize=9)
    else:ax.text(.5,.5,'No verified native intensity values; no substitute curve',ha='center',transform=ax.transAxes)
    fig.suptitle(f"{payload['model']} | {storm} | {'Wind' if field=='windKt' else 'Pressure'}",x=.055,y=.975,ha='left',fontsize=17,color='#284c71')
    fig.text(.055,.925,f"Initialization {payload['run']} | Same native numbered system only | Missing intensity is not zero",fontsize=9,color='#42586e')
    chart_footer(fig,payload,'Native ATCF 34-kt radius rows deduplicated; VMAX unchanged, not a >=34kt selection. No pressure-derived wind or field-wind substitution.')
    save(fig,destination)
    return {'metric':'wind' if field=='windKt' else 'pressure','unit':'kt' if field=='windKt' else 'hPa','meanPoints':len(mean),'minimumMembers':8,
            'counts':[[p['hour'],p['count']] for p in mean]}


def export_native(payload,destination):
    output=io.StringIO();writer=csv.writer(output)
    writer.writerow(['model','initialization','valid_utc','kind','sample','native_member','source_id','source_basin','source_storm_number','lead_hours','latitude','longitude','tracker_vmax_kt','minimum_mslp_hpa','field_10m_max_speed_ms','source_file','method'])
    run=parse_run(payload['run'])
    for t in payload['tracks']:
        for p in t['points']:
            valid=(run+dt.timedelta(hours=p['hour'])).isoformat().replace('+00:00','Z')
            writer.writerow([payload['model'],payload['run'],valid,t['kind'],t['sample'],t['nativeMember'],t['sourceId'],t.get('nativeBasin',''),t.get('nativeStormNumber',''),p['hour'],p['lat'],p['lon'],p['windKt'],p['pressureHpa'],p['windMs'],t['sourceFile'],t['method']])
    destination.write_text(output.getvalue())


def generate(out,sources=None,regions=None,data_ref='ensemble-track-data'):
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(Path(__file__).parent/'templates/ncep-ensembles.html',out/'index.html')
    index=out/'index.json';prior=json.loads(index.read_text()) if index.exists() else {'schema':1,'generator':VERSION,'records':[]}
    records=[r for r in prior.get('records',[]) if r.get('generator')==VERSION];changed=False
    for pattern in ('*.svg','*.svgz'):
        for path in out.rglob(pattern):path.unlink()
    regions=regions or REGIONS
    for model in HORIZONS:
        payload,digest=read_publication(model,(sources or {}).get(model),data_ref)
        existing=next((r for r in records if r['model']==model and r['run']==payload['run'] and r.get('sourceSha256')==digest and r.get('generator')==VERSION),None)
        if existing and all((out/a).is_file() for a in existing['assets']):
            print(f'{model} {payload["run"]}: exact source already rendered; preserve charts',flush=True);continue
        key=f"runs/{model}/{payload['run'].replace('-','').replace(':','')}"
        folder=out/key;folder.mkdir(parents=True,exist_ok=True)
        record={'model':model,'run':payload['run'],'generatedAt':dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds').replace('+00:00','Z'),
                'generator':VERSION,'sourceSha256':digest,'publicationCommit':data_ref,'ensembleSize':31,'horizonHours':HORIZONS[model],'sourceCheckedAt':payload['checkedAt'],
                'trackerMembers':sum(m['tracker']=='available' for m in payload['members']),'genesisMembers':sum(m['genesis']=='available' for m in payload['members']),
                'derived':payload['derived'],'regions':[],'storms':[],'assets':[], 'data':key+'/source.json','csv':key+'/native.csv'}
        (folder/'source.json').write_text(json.dumps(payload,ensure_ascii=False,separators=(',',':'),allow_nan=False)+'\n')
        export_native(payload,folder/'native.csv')
        def asset(base):return {'png':key+'/'+base+'.png'}
        for region in regions:
            base='regions/'+region['id'];stats=map_chart(payload,region,folder/base)
            record['regions'].append({'id':region['id'],'label':region['label'],'bounds':region['bounds'],**asset(base),**stats})
        for storm in sorted({t['trackId'] for t in payload['tracks'] if t['kind']=='matched'}):
            tracks=[t for t in payload['tracks'] if t['kind']=='matched' and t['trackId']==storm]
            points=[p for t in tracks for p in t['points']];reference=points[0]['lon']
            lons=[reference+(p['lon']-reference+180)%360-180 for p in points];lats=[p['lat'] for p in points]
            bounds=[min(lons)-4,max(lons)+4,max(-85,min(lats)-4),min(85,max(lats)+4)]
            region={'id':storm,'label':storm,'bounds':bounds}
            base='storms/'+storm
            stats=map_chart(payload,region,folder/(base+'-track'),storm)
            entry={'id':storm,'members':len({t['sample'] for t in tracks}),'maxNativeHour':max(p['hour'] for p in points),'track':{**asset(base+'-track'),**stats}}
            for field,label in [('windKt','wind'),('pressureHpa','pressure')]:
                stats=intensity_chart(payload,storm,field,folder/(base+'-'+label));entry[label]={**asset(base+'-'+label),**stats}
            record['storms'].append(entry)
        record['assets']=sorted(str(p.relative_to(out)) for p in folder.rglob('*') if p.is_file())
        records=[r for r in records if not(r['model']==model and r['run']==payload['run'])]+[record];changed=True
        print(f'{model}: generated {len(record["regions"])} basin maps and {len(record["storms"])} separate-storm track/wind/pressure sets from actual 31-member publication',flush=True)
    keep=[]
    for model in HORIZONS:keep.extend(sorted((r for r in records if r['model']==model),key=lambda r:r['run'],reverse=True)[:2])
    used={str((out/f"runs/{r['model']}/{r['run'].replace('-','').replace(':','')}").resolve()) for r in keep}
    for model in HORIZONS:
        parent=out/'runs'/model
        if parent.exists():
            for folder in parent.iterdir():
                if folder.is_dir() and str(folder.resolve()) not in used:shutil.rmtree(folder)
    size=lambda:sum(p.stat().st_size for p in out.rglob('*') if p.is_file())
    # WM-6 reserves 900 MiB; keep this tree <=48 MiB on their shared Pages site.
    # Prefer two distinct bases/model, but never sacrifice the other model's latest.
    while size()>48*1024*1024:
        removable=[r for r in keep if sum(q['model']==r['model'] for q in keep)>1]
        if not removable:
            raise ValueError('Latest NCEP charts exceed shared-site budget; refusing publication')
        oldest=min(removable,key=lambda r:r['run']);keep.remove(oldest)
        folder=out/f"runs/{oldest['model']}/{oldest['run'].replace('-','').replace(':','')}"
        if folder.is_dir():shutil.rmtree(folder)
        changed=True
    if changed:
        index.write_text(json.dumps({'schema':1,'generator':VERSION,'updatedAt':dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds').replace('+00:00','Z'),'records':keep},ensure_ascii=False,separators=(',',':'))+'\n')
    return changed


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--out',default='.generated-site/ncep-ensembles');parser.add_argument('--data-ref',default='ensemble-track-data');args=parser.parse_args()
    generate(args.out,data_ref=args.data_ref)
