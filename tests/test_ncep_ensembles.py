"""Native public NCEP fixtures plus explicitly synthetic tracking edge cases."""
import datetime as dt
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('ncep',Path(__file__).parents[1]/'scripts/ncep_ensembles.py')
ncep=importlib.util.module_from_spec(spec);spec.loader.exec_module(ncep)
FIX=Path(__file__).parent/'fixtures/ncep'


def low(hour,lat=13,lon=140):
    return {'hour':hour,'lat':lat,'lon':lon,'windKt':None,'pressureHpa':1000.,'windMs':22.1}


class NativeTrackerTests(unittest.TestCase):
    def test_real_aigefs_native_vmax_pressure_members_and_radius_selection(self):
        run=ncep.parse_run('2026-10-18T06:00:00Z')
        tracks=ncep.parse_atcf((FIX/'a001-2026101806.atcf').read_text(),'AIGEFS',run,1)
        wp=next(t for t in tracks if t['trackId']=='WP292026')
        self.assertEqual(wp['nativeMember'],'A001')
        self.assertEqual(wp['sample'],1)
        self.assertEqual(len(wp['points']),1) # Three radius rows, not three members/fixes.
        self.assertEqual(wp['points'][0],{'hour':0,'lat':12.8,'lon':142.5,'windKt':92,'pressureHpa':989,'windMs':None})
        self.assertEqual(ncep.member_id('AIGEFS',0),'A000')
        self.assertEqual(ncep.member_id('AIGEFS',30),'A030')
        self.assertNotIn('aimn',ncep.tracker_path('AIGEFS',run,0))

    def test_real_gefs_member_and_original_genesis_token_are_distinct_formats(self):
        run=ncep.parse_run('2026-10-18T00:00:00Z')
        tracks=ncep.parse_atcf((FIX/'ap01-2026101800.atcf').read_text(),'GEFS',run,1)
        wp=next(t for t in tracks if t['trackId']=='WP292026')
        self.assertEqual(wp['points'][0]['windKt'],76)
        self.assertEqual(wp['points'][0]['pressureHpa'],973)
        gen=ncep.parse_atcf((FIX/'genesis-ac00-2026101800.atcf').read_text(),'GEFS',run,0,True)
        self.assertEqual(len(gen),1)
        self.assertEqual(gen[0]['trackId'],'2026101800_F042_105N_0916W_FOF')
        self.assertEqual(gen[0]['nativeMember'],'AC00')
        self.assertEqual([p['hour'] for p in gen[0]['points']],[42,48,54])
        self.assertEqual(gen[0]['points'][0]['windKt'],21) # 34 row is NOT a VMAX threshold.
        self.assertEqual(gen[0]['points'][0]['pressureHpa'],1008)
        self.assertAlmostEqual(gen[0]['points'][0]['lon'],-91.6)
        self.assertEqual(ncep.member_id('GEFS',30),'AP30')
        with self.assertRaises(ValueError):
            ncep.parse_atcf((FIX/'genesis-ac00-2026101800.atcf').read_text(),'AIGEFS',run,0,True)

    def test_refuse_cross_cycle_member_and_malformed_coordinates(self):
        text=(FIX/'a001-2026101806.atcf').read_text()
        for run,sample in [('2026-10-18T00:00:00Z',1),('2026-10-18T06:00:00Z',0)]:
            with self.assertRaisesRegex(ValueError,'cycle/member'):
                ncep.parse_atcf(text,'AIGEFS',ncep.parse_run(run),sample)
        for value,latitude in [('999N',True),('13.0N',True),('9999E',False),('130X',False)]:
            with self.assertRaises(ValueError):
                ncep.coordinate(value,latitude)
        for value in ('2026-10-18T05:00:00Z','2026-02-30T00:00:00Z'):
            with self.assertRaises(ValueError):
                ncep.parse_run(value)

    def test_conflicting_same_utc_not_averaged_and_zero_is_missing(self):
        text=(FIX/'a001-2026101806.atcf').read_text().splitlines()[0]
        conflicting=text.replace(',  91,',',  92,')
        tracks=ncep.parse_atcf(text+'\n'+conflicting,'AIGEFS',ncep.parse_run('2026-10-18T06:00:00Z'),1)
        self.assertEqual(tracks,[])
        self.assertIsNone(ncep.scalar('0',1,250))
        self.assertIsNone(ncep.scalar('-9999',800,1100))

    def test_native_horizons_are_clipped_not_extended(self):
        row=(FIX/'ap01-2026101800.atcf').read_text().splitlines()[0]
        text=row+'\n'+row.replace(', 000,',', 120,')+'\n'+row.replace(', 000,',', 126,')
        tracks=ncep.parse_atcf(text,'GEFS',ncep.parse_run('2026-10-18T00:00:00Z'),1)
        self.assertEqual([p['hour'] for p in tracks[0]['points']],[0,120])
        self.assertEqual(ncep.HORIZONS,{'GEFS':120,'AIGEFS':240})

    def test_index_checks_variable_native_level_cycle_member_lead_and_ranges(self):
        text=(FIX/'a001-f006.idx').read_text();run=ncep.parse_run('2026-10-18T06:00:00Z')
        ranges=ncep.field_ranges(text,run,1,6)
        self.assertEqual(ranges,{'UGRD':(0,866329),'VGRD':(866330,1726489),'PRMSL':(2194017,3267559)})
        for bad in (text.replace('P-ENS=1','P-ENS=2'),text.replace('6 hour fcst','12 hour fcst'),text.replace('10 m above ground','100 m above ground'),text.replace('2026101806','2026101800')):
            with self.assertRaises(ValueError):
                ncep.field_ranges(bad,run,1,6)

    def test_unavailable_members_never_shrink_declared_denominator(self):
        run=ncep.parse_run('2026-10-18T06:00:00Z')
        def fake(url,*args):
            if '/a001.' in url:return (FIX/'a001-2026101806.atcf').read_bytes()
            raise TimeoutError('synthetic unavailable member')
        with patch.object(ncep,'get',side_effect=fake):
            payload=ncep.native_dataset('AIGEFS',run)
        self.assertEqual(payload['ensembleSize'],31)
        self.assertEqual(len(payload['members']),31)
        self.assertEqual(len(payload['failures']),30)
        self.assertEqual(payload['derived']['status'],'pending')
        self.assertEqual(sum(m['tracker']=='available' for m in payload['members']),1)
        self.assertEqual({t['sample'] for t in payload['tracks']},{1})
        with tempfile.TemporaryDirectory() as folder:
            ncep.write_dataset(payload,folder)
            self.assertEqual(json.loads((Path(folder)/'AIGEFS.json').read_text())['ensembleSize'],31)
            self.assertFalse(any(p.suffix=='.grib2' for p in Path(folder).iterdir()))

    def test_duplicate_genesis_needs_same_member_multiple_exact_utc_fixes(self):
        native={'sample':1,'kind':'matched','trackId':'WP292026','points':[low(0),low(6)]}
        gen={'sample':1,'points':[low(0,13.1),low(6,13.1)]}
        self.assertEqual(ncep.duplicate_of_native(gen,[native]),'WP292026')
        self.assertIsNone(ncep.duplicate_of_native({**gen,'sample':2},[native]))
        self.assertIsNone(ncep.duplicate_of_native({**gen,'points':[low(0)]},[native]))
        self.assertIsNone(ncep.duplicate_of_native({**gen,'points':[low(0,20),low(6,20)]},[native]))

    def test_real_gefs_genesis_contains_both_tg_and_hc_without_inventing_tc_identity(self):
        run=ncep.parse_run('2026-10-18T06:00:00Z')
        tracks=ncep.parse_atcf((FIX/'genesis-mixed-ac00-2026101806.atcf').read_text(),'GEFS',run,0,True)
        self.assertEqual({t['nativeBasin'] for t in tracks},{'TG','HC','EP'})
        ep=next(t for t in tracks if t['nativeBasin']=='EP')
        self.assertEqual(ep['nativeStormNumber'],'21E')
        self.assertEqual(ep['sourceId'],'2026101806_F000_184N_1061W_21E')
        self.assertEqual(ep['kind'],'genesis')
        hc=next(t for t in tracks if t['nativeBasin']=='HC')
        self.assertEqual(hc['nativeStormNumber'],'01G')
        self.assertEqual(hc['sourceId'],'2026101806_F000_104N_0713W_01G')
        self.assertEqual(hc['points'][0]['windKt'],21)
        self.assertEqual(hc['kind'],'genesis')

    def test_analysis_last_pressure_message_is_not_mislabelled_missing(self):
        ranges=ncep.field_ranges((FIX/'a000-f000.idx').read_text(),ncep.parse_run('2026-10-18T06:00:00Z'),0,0)
        self.assertEqual(ranges['PRMSL'],(2157959,None))
        self.assertEqual(ranges['VGRD'],(866982,1702274))

    def test_open_ended_tail_still_requires_exact_206_content_range_and_length(self):
        class Response:
            status=206
            headers={'Content-Range':'bytes 20-29/30'}
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self,n):return b'0123456789'
        with patch.object(ncep._opener,'open',return_value=Response()),patch.object(ncep,'_next_request',0):
            self.assertEqual(ncep.get(ncep.GRID+'test.grib2',20,(20,None)),b'0123456789')
        Response.headers={'Content-Range':'bytes 20-28/30'}
        with patch.object(ncep._opener,'open',return_value=Response()),patch.object(ncep,'_next_request',0):
            with self.assertRaisesRegex(ValueError,'range'):
                ncep.get(ncep.GRID+'test.grib2',20,(20,None))


class ConservativeLowTests(unittest.TestCase):
    def setUp(self):
        self.run=ncep.parse_run('2026-10-18T06:00:00Z')

    def test_baseline_is_not_genesis_and_new_birth_requires_actual_sequence(self):
        active,ended=ncep.advance_lows([], [low(0),low(0,40,100)],self.run,0,0)
        self.assertEqual(len(active),2)
        self.assertTrue(all(t['baseline'] for t in active))
        active,ended=ncep.advance_lows(active,[low(6),low(6,40,100),low(6,10,160)],self.run,0,6)
        births=[t for t in active if not t['baseline']]
        self.assertEqual(len(births),1)
        self.assertEqual(births[0]['points'],[low(6,10,160)])
        self.assertEqual(births[0]['points'][0]['windMs'],22.1)
        self.assertIsNone(births[0]['points'][0]['windKt'])
        active,_=ncep.advance_lows(active,[low(12),low(12,40,100),low(12,10.2,159.8)],self.run,0,12)
        self.assertEqual(len(next(t for t in active if not t['baseline'])['points']),2)

    def test_ambiguity_and_shared_candidate_stop_without_new_birth(self):
        active,_=ncep.advance_lows([],[low(0)],self.run,0,0)
        result,ended=ncep.advance_lows(active,[low(6,13,139.5),low(6,13,140.5)],self.run,0,6)
        self.assertEqual(result,[])
        self.assertEqual(len(ended),1)
        active,_=ncep.advance_lows([],[low(0,13,139),low(0,13,141)],self.run,0,0)
        result,ended=ncep.advance_lows(active,[low(6)],self.run,0,6)
        self.assertEqual(result,[])
        self.assertEqual(len(ended),2)

    def test_missing_fields_stop_member_no_post_gap_birth(self):
        calls=[]
        def grid(run,sample,hour,cache):
            calls.append(hour)
            if hour==18:raise ValueError('synthetic missing field')
            return None,None,None,None
        def lows(p,w,lats,lons,hour):
            return [] if hour==0 else [low(hour,10,160)]
        with patch.object(ncep,'grid_fields',side_effect=grid),patch.object(ncep,'closed_lows',side_effect=lows):
            tracks,count,error=ncep.derived_member(self.run,0,'unused')
        self.assertEqual(calls,[0,6,12,18])
        self.assertEqual(count,3)
        self.assertEqual([p['hour'] for p in tracks[0]['points']],[6,12])
        self.assertIn('+18h',error)
        self.assertEqual(tracks[0]['kind'],'derived_low')

    def test_missing_first_field_yields_no_native_zero_weather(self):
        with patch.object(ncep,'grid_fields',side_effect=ValueError('missing actual field')):
            tracks,count,error=ncep.derived_member(self.run,30,'unused')
        self.assertEqual((tracks,count),([],0))
        self.assertIn('+0h',error)

    def test_plateaus_unclosed_noise_and_tropical_native_l_with_vector_wind(self):
        try:
            import numpy as np
            import scipy
        except ImportError:
            self.skipTest('Native numerical dependencies are verified in Ubuntu workflow')
        import numpy as np
        lats=np.arange(30,-.01,-.25);lons=np.arange(120,150,.25)
        dy=(lats[:,None]-15)*111.2;dx=(lons[None,:]-135)*111.2*math_cos(15)
        radius=np.sqrt(dx**2+dy**2)
        pressure=1000+np.minimum(radius/100,5)
        wind=np.full_like(pressure,12.)
        found=ncep.closed_lows(pressure,wind,lats,lons,6)
        self.assertEqual(len(found),1)
        self.assertEqual((found[0]['lat'],found[0]['lon']),(15.,135.))
        self.assertEqual(found[0]['pressureHpa'],1000.)
        self.assertEqual(found[0]['windMs'],12.)
        self.assertIsNone(found[0]['windKt'])
        self.assertEqual(ncep.closed_lows(np.full_like(pressure,1000),wind,lats,lons,6),[])
        self.assertEqual(ncep.closed_lows(1000+np.minimum(radius/10000,.2),wind,lats,lons,6),[])


class CompactCheckpointTests(unittest.TestCase):
    """Explicitly synthetic fields exercise storage/resume, not real guidance."""
    def setUp(self):self.run=ncep.parse_run('2026-10-18T06:00:00Z')

    def track(self,sample=0):
        active,_=ncep.advance_lows([],[low(6)],self.run,sample,6)
        active,_=ncep.advance_lows(active,[low(12)],self.run,sample,12)
        t=active[0];t.pop('baseline');return t

    def test_compact_method_keeps_actual_field_values_and_full_definition(self):
        t=self.track()
        self.assertEqual(t['method'],'local-field-l-v1')
        self.assertEqual(t['points'],[low(6),low(12)])
        self.assertLess(len(t['method'].encode()),len(ncep.METHOD.encode())//10)

    def test_complete_checkpoint_roundtrips_but_partial_or_different_method_is_not_resumed(self):
        with tempfile.TemporaryDirectory() as folder:
            t=self.track();value=([t],41,'')
            ncep.member_checkpoint(folder,self.run,0,value)
            self.assertEqual(ncep.member_checkpoint(folder,self.run,0),value)
            p=next(Path(folder).glob('*.json'));data=json.loads(p.read_text())
            data['fields']=40;p.write_text(json.dumps(data))
            self.assertIsNone(ncep.member_checkpoint(folder,self.run,0))
            data['fields']=41;data['methodSha256']='wrong';p.write_text(json.dumps(data))
            self.assertIsNone(ncep.member_checkpoint(folder,self.run,0))

    def test_checkpoint_rejects_wrong_units_gap_and_member_identity(self):
        for change in [lambda t:t['points'][0].update(windKt=22.1),lambda t:t['points'][1].update(hour=24),lambda t:t.update(nativeMember='A001')]:
            with tempfile.TemporaryDirectory() as folder:
                t=self.track();change(t)
                ncep.member_checkpoint(folder,self.run,0,([t],41,''))
                with self.assertRaises(ValueError):ncep.member_checkpoint(folder,self.run,0)

    def test_full_31_member_checkpoints_survive_without_any_grid_reread(self):
        payload={'model':'AIGEFS','run':ncep.iso(self.run),'tracks':[],'failures':[]}
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(ncep,'derived_member',side_effect=lambda run,m,cache:([self.track(m)],41,'')):
                first=ncep.hybrid_dataset(payload,'unused',folder)
            self.assertEqual(first['derived']['fields'],1271)
            self.assertEqual(first['derived']['method'],ncep.METHOD)
            self.assertEqual(len(list(Path(folder).glob('*.json'))),31)
            with patch.object(ncep,'derived_member',side_effect=AssertionError('must not redownload verified member fields')):
                resumed=ncep.hybrid_dataset(payload,'unused',folder,True)
            self.assertEqual(first['tracks'],resumed['tracks'])
            self.assertEqual(resumed['derived']['membersComplete'],31)

    def test_publication_budget_is_bounded_but_does_not_repeat_the_old_8mb_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            payload={'model':'AIGEFS','run':ncep.iso(self.run),'tracks':[self.track()],'derived':{'status':'available'},
                     'explicitlySyntheticBudgetPadding':'x'*8_100_000}
            ncep.write_dataset(payload,folder)
            self.assertEqual(json.loads((Path(folder)/'AIGEFS.json').read_text())['tracks'][0]['points'],[low(6),low(12)])
            payload['explicitlySyntheticBudgetPadding']='x'*16_000_000
            with self.assertRaisesRegex(ValueError,'budget'):ncep.write_dataset(payload,folder)


def math_cos(degrees):
    import math
    return math.cos(math.radians(degrees))


if __name__=='__main__':unittest.main()
