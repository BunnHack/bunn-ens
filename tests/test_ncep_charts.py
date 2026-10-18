"""Offline chart tests use explicitly synthetic ensembles, never claimed as live data."""
import copy
import csv
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET
from scripts import ncep_charts as charts


def synthetic(model='GEFS'):
    run='2026-10-18T06:00:00Z'
    tracks=[]
    for sample in range(31):
        tracks.append({'sample':sample,'nativeMember':charts.member_id(model,sample),'trackId':'WP292026','sourceId':'WP292026',
                       'nativeBasin':'WP','nativeStormNumber':'29','sourceFile':'https://nomads.ncep.noaa.gov/synthetic-test-fixture',
                       'kind':'matched','method':'SYNTHETIC UNIT TEST, NOT PROVIDER DATA','points':[
                           {'hour':h,'lat':13+h/20+sample/100,'lon':142-h/10,'windKt':80+sample,'pressureHpa':990-sample,'windMs':None} for h in (0,6,12)]})
    return {'schema':1,'generator':'ncep-hybrid-v1','model':model,'run':run,'checkedAt':'2026-10-18T12:00:00Z','horizonHours':charts.HORIZONS[model],
            'ensembleSize':31,'windUnit':'kt','fieldWindUnit':'m/s','pressureUnit':'hPa','members':[
                {'sample':s,'nativeId':charts.member_id(model,s),'tracker':'available','genesis':'available' if model=='GEFS' else 'not_published'} for s in range(31)],
            'derived':{'status':'not_needed' if model=='GEFS' else 'pending','fields':0},'tracks':tracks}


class StaticChartTests(unittest.TestCase):
    def test_raw_intensity_conditional_mean_full_31_and_minimum_eight(self):
        payload=synthetic();original=copy.deepcopy(payload)
        means=charts.conditional_mean(payload['tracks'],'windKt')
        self.assertEqual([p['count'] for p in means],[31,31,31])
        self.assertEqual(means[0]['value'],95)
        self.assertEqual(means[0]['minimum'],80)
        self.assertEqual(means[0]['maximum'],110)
        self.assertEqual(charts.conditional_mean(payload['tracks'][:7],'windKt'),[])
        self.assertEqual(charts.conditional_mean(payload['tracks'][:8],'windKt')[0]['count'],8)
        self.assertEqual(payload,original)

    def test_no_mean_for_unrelated_storms_single_member_or_field_lows(self):
        tracks=synthetic()['tracks']
        mixed=copy.deepcopy(tracks);mixed[-1]['trackId']='EP212026'
        self.assertEqual(charts.conditional_mean(mixed),[])
        self.assertEqual(charts.conditional_mean(tracks[:1]),[])
        derived=copy.deepcopy(tracks)
        for t in derived:t['kind']='derived_low'
        self.assertEqual(charts.conditional_mean(derived,'windKt'),[])

    def test_missing_is_not_zero_and_duplicate_members_cannot_inflate_n(self):
        tracks=copy.deepcopy(synthetic()['tracks'])
        for t in tracks[7:]:
            for p in t['points']:p['windKt']=None
        self.assertEqual(charts.conditional_mean(tracks,'windKt'),[])
        tracks=synthetic()['tracks'][:8];duplicate=copy.deepcopy(tracks[0]);duplicate['points'][0]['windKt']=240
        mean=charts.conditional_mean(tracks+[duplicate],'windKt')
        self.assertNotIn(0,[p['hour'] for p in mean])
        self.assertEqual(mean[0]['count'],8)

    def test_native_leads_gaps_and_dateline_are_not_filled_or_long_bridged(self):
        points=[{'hour':0,'lat':13,'lon':179},{'hour':6,'lat':14,'lon':-179},{'hour':24,'lat':15,'lon':-177}]
        pieces=charts.segments(points,100,210)
        self.assertEqual(len(pieces),1)
        self.assertEqual(pieces[0][2],[(179,13),(181,14)])
        self.assertEqual(charts.segments([points[0],points[-1]],100,210),[])
        self.assertEqual(charts.segments([points[0],{**points[1],'hour':12}],100,210,max_gap=6),[])

    def test_existing_exact_category_thresholds_and_colours_unchanged(self):
        self.assertEqual(charts.CATEGORIES,[(137,'C5','#ef50ef'),(113,'C4','#800000'),(96,'C3','#ff0000'),(83,'C2','#ff8000'),(64,'C1','#f4d500'),(34,'TS','#00aaff'),(25,'Depression','#009e00'),(0,'Disturbance','#00e617')])
        self.assertEqual(charts.wind_color(136.9),'#800000')
        self.assertEqual(charts.wind_color(137),'#ef50ef')
        self.assertEqual(charts.wind_color(None),'#7b8798')
        self.assertEqual(charts.wind_color(0),'#00e617')

    def test_reject_model_unit_member_and_asset_identity_substitution(self):
        for mutate in (lambda p:p.update(model='AIGEFS'),lambda p:p.update(ensembleSize=30),lambda p:p.update(windUnit='m/s'),lambda p:p['tracks'][0].update(trackId='../../private',sourceId='../../private'),lambda p:p['tracks'][0]['points'][0].update(windMs=30)):
            p=synthetic();mutate(p)
            with self.assertRaises(ValueError):charts.validate(p,'GEFS')
        with self.assertRaises(ValueError):charts.read_publication('GEFS',data_ref='../../other-model')

    def test_true_png_svg_dimensions_signatures_and_vector_content(self):
        from PIL import Image
        payload=synthetic()
        with tempfile.TemporaryDirectory() as d:
            folder=Path(d)
            charts.map_chart(payload,charts.REGIONS[1],folder/'track','WP292026')
            stats=charts.intensity_chart(payload,'WP292026','windKt',folder/'wind')
            charts.intensity_chart(payload,'WP292026','pressureHpa',folder/'pressure')
            for name,size in [('track',(2000,1300)),('wind',(2000,1200)),('pressure',(2000,1200))]:
                data=(folder/(name+'.png')).read_bytes();self.assertEqual(data[:8],b'\x89PNG\r\n\x1a\n')
                image=Image.open(io.BytesIO(data));image.load();self.assertEqual(image.size,size)
                root=ET.parse(folder/(name+'.svg')).getroot();self.assertTrue(root.tag.endswith('svg'))
                self.assertGreater(len(root.findall('.//{http://www.w3.org/2000/svg}path')),10)
            self.assertEqual(stats['counts'],[[0,31],[6,31],[12,31]])

    def test_native_csv_keeps_field_ms_separate_and_missing_wind_blank(self):
        payload=synthetic('AIGEFS');t=copy.deepcopy(payload['tracks'][0]);t.update(kind='derived_low',trackId='synthetic-low',sourceId='synthetic-low')
        t['points']=[{**p,'hour':p['hour']+6,'windKt':None,'windMs':22.1} for p in t['points']];payload['tracks'].append(t)
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'native.csv';charts.export_native(payload,path)
            rows=list(csv.DictReader(io.StringIO(path.read_text())))
            low=next(r for r in rows if r['kind']=='derived_low')
            self.assertEqual(low['tracker_vmax_kt'],'');self.assertEqual(low['field_10m_max_speed_ms'],'22.1')
            self.assertEqual(low['valid_utc'],'2026-10-18T12:00:00Z')
            self.assertEqual(rows[0]['tracker_vmax_kt'],'80')
            self.assertEqual(rows[0]['minimum_mslp_hpa'],'990')

    def test_manifest_assets_backward_retention_and_exact_source_skip(self):
        def render(payload,region,destination,storm=None):
            destination.parent.mkdir(parents=True,exist_ok=True)
            for ext in ('.png','.svg'):destination.with_suffix(ext).write_text('SYNTHETIC ASSET FOR CACHE TEST ONLY')
            return {'trajectoryCount':31,'separateStormMeans':1}
        def intensity(payload,storm,field,destination):return render(payload,None,destination)
        with tempfile.TemporaryDirectory() as folder:
            out=Path(folder)/'site'
            with patch.object(charts,'read_publication',side_effect=lambda model,source,ref:(synthetic(model),model+'-digest')),patch.object(charts,'map_chart',side_effect=render) as maps,patch.object(charts,'intensity_chart',side_effect=intensity):
                self.assertTrue(charts.generate(out,regions=charts.REGIONS[:1]))
                first=(out/'index.json').read_bytes();self.assertTrue((out/'index.html').is_file())
                manifest=json.loads(first);self.assertEqual(len(manifest['records']),2)
                self.assertEqual({r['horizonHours'] for r in manifest['records']},{120,240})
                self.assertTrue(all((out/a).is_file() for r in manifest['records'] for a in r['assets']))
                count=maps.call_count
                self.assertFalse(charts.generate(out,regions=charts.REGIONS[:1]));self.assertEqual(maps.call_count,count)
                self.assertEqual((out/'index.json').read_bytes(),first)
                self.assertFalse(any(p.suffix in ('.grib2','.nc','.zip') for p in out.rglob('*')))


if __name__=='__main__':unittest.main()
