import datetime as dt
import importlib.util
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import numpy as np

spec=importlib.util.spec_from_file_location('low_tracks',Path(__file__).parents[1]/'scripts/low_tracks.py')
m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)
BASE=dt.datetime(2026,10,17,18,tzinfo=m.UTC)
NATIVE=bool(importlib.util.find_spec('eccodes') and importlib.util.find_spec('netCDF4'))

class LowTests(unittest.TestCase):
    def grid(self,center=145):
        lats=np.arange(0,31,.25);lons=np.arange(0,360,.25)
        dx=(lons-center+180)%360-180
        g=980+np.minimum(40,((lats[:,None]-13)**2+dx[None,:]**2)*2)
        return g,lats,lons

    def test_closed_low_native_grid_and_distance(self):
        g,a,b=self.grid();seed=dict(lat=13,lon=145)
        p=m.find_lows(g,a,b,seed,250)
        self.assertEqual(len(p),1);self.assertEqual(p[0]['pressureHpa'],980)
        self.assertEqual(p[0]['lat'],13);self.assertEqual(p[0]['lon'],145)
        self.assertEqual(m.find_lows(g,a,b,dict(lat=20,lon=155),250),[])

    def test_dateline_periodicity(self):
        g,a,b=self.grid(359.75)
        p=m.find_lows(g,a,b,dict(lat=13,lon=-.25),250)
        self.assertEqual(p[0]['lon'],-.25)

    def test_open_trough_plateau_high_and_shallow_not_centres(self):
        g,a,b=self.grid()
        self.assertEqual(m.find_lows(np.full_like(g,990),a,b,dict(lat=13,lon=145),250),[])
        self.assertEqual(m.find_lows(g+40,a,b,dict(lat=13,lon=145),250),[])
        self.assertEqual(m.find_lows(990+(g-980)*.001,a,b,dict(lat=13,lon=145),250),[])
        g[:]=990+np.minimum(40,(a[:,None]-13)**2)
        self.assertEqual(m.find_lows(g,a,b,dict(lat=13,lon=145),250),[])

    def test_ambiguous_lows_stop_and_no_candidates_stop(self):
        seed=dict(lat=13,lon=145)
        p,reason=m.choose_low([dict(lat=13,lon=144),dict(lat=13,lon=146)],seed)
        self.assertIsNone(p);self.assertIn('歧义',reason)
        self.assertIsNone(m.choose_low([],seed)[0])

    def test_range_index_is_unique_time_pinned_and_bounded(self):
        self.assertEqual(m.pressure_range('1:0:d=2026101718:PRMSL:mean sea level:anl:\n2:99:d=2026101718:TMP:2 m above ground:anl:',BASE,0),(0,98))
        self.assertEqual(m.pressure_range('1:42:d=2026101718:PRMSL:mean sea level:6 hour fcst:',BASE,6),(42,None))
        for idx in ['1:0:d=2026101712:PRMSL:mean sea level:anl:', '1:0:d=2026101718:PRMSL:mean sea level:6 hour fcst:', '1:0:d=2026101718:TMP:mean sea level:anl:']:
            with self.assertRaises(ValueError):m.pressure_range(idx,BASE,0)

    def test_seed_is_same_utc_forecast_not_invented_analysis(self):
        p=dict(datetime='2026-10-17 12:00:00',validtime='2026-10-17 18:00:00',fcsthour=6,xuhao=20260131,fcsttype='FUXI',engname='CHAMPI',zone='W',lat=13,lon=145)
        payload=dict(entries=[dict(xuhao=20260131,FCSTType='FUXI',enname='CHAMPI',points=[p])])
        seed=m.seeds_at(payload,BASE)[0]
        self.assertEqual(seed['leadHours'],6);self.assertEqual(seed['validTime'],m.iso(BASE));self.assertNotIn('atcfId',seed)
        p['fcsthour']=0;self.assertEqual(m.seeds_at(payload,BASE),[])

    def test_track_stops_on_field_failure_never_restarts_or_fills(self):
        seed=dict(code='20260131',name='CHAMPI',basin='W',lat=13,lon=145)
        g,a,b=self.grid()
        with patch.object(m,'discover_aigfs',return_value=(BASE,m.NOAA)),patch.object(m,'seeds_at',return_value=[seed]),patch.object(m,'aigfs_field',side_effect=[((g,a,b),{}),((g,a,b),{}),ValueError('missing'),((g,a,b),{})]) as field:
            rows,state=m.generate_aigfs(BASE,{})
        self.assertEqual(field.call_count,3);self.assertEqual([p['leadHours'] for p in rows[0]['points']],[0,6]);self.assertEqual(state['status'],'partial');self.assertTrue(all(p['windMs'] is None for p in rows[0]['points']))

    def test_shared_low_never_merges_two_seed_systems(self):
        seed=dict(code='20260131',name='CHAMPI',basin='W',lat=13,lon=145)
        g,a,b=self.grid()
        with patch.object(m,'discover_aigfs',return_value=(BASE,m.NOAA)),patch.object(m,'seeds_at',return_value=[seed,dict(seed,code='20260132')]),patch.object(m,'aigfs_field',return_value=((g,a,b),{})):
            with self.assertRaisesRegex(ValueError,'No unambiguous'):m.generate_aigfs(BASE,{})

    def test_unavailable_refresh_preserves_dated_results(self):
        previous=dict(generator=m.VERSION,tracks=[dict(model='AIGFS',directoryRun=m.iso(BASE),points=[{'lat':13}])])
        with patch.object(m,'get',return_value=(__import__('json').dumps(previous).encode(),{})),patch.object(m,'generate_aigfs',side_effect=ValueError()),patch.object(m,'generate_sd3',side_effect=ValueError()):
            r=m.generate(BASE)
        self.assertTrue(r['tracks'][0]['retained']);self.assertEqual(r['models'][0]['status'],'retained');self.assertEqual(r['models'][1]['status'],'unavailable')

    def test_source_limits_and_workflow_isolated_from_chart_publication(self):
        with self.assertRaises(ValueError):m.get('http://nomads.ncep.noaa.gov/unsafe')
        with self.assertRaises(ValueError):m.get('https://evil.invalid/data')
        workflow=(Path(__file__).parents[1]/'.github/workflows/model-tracks.yml').read_text()
        self.assertIn('model-track-data',workflow);self.assertNotIn('deploy-pages',workflow);self.assertNotIn('secrets.',workflow)
        self.assertNotIn('GEML',(Path(__file__).parents[1]/'scripts/low_tracks.py').read_text())

    @unittest.skipUnless(NATIVE,'native decoders verified on Ubuntu')
    def test_actual_grib_decoder_checks_identity_units_and_cycle(self):
        import eccodes as ec
        g=ec.codes_grib_new_from_samples('regular_ll_sfc_grib2')
        try:
            for k,v in dict(Ni=1440,Nj=721,latitudeOfFirstGridPointInDegrees=90,latitudeOfLastGridPointInDegrees=-90,longitudeOfFirstGridPointInDegrees=0,longitudeOfLastGridPointInDegrees=359.75,iDirectionIncrementInDegrees=.25,jDirectionIncrementInDegrees=.25,dataDate=20261017,dataTime=1800,shortName='msl',typeOfLevel='meanSea',forecastTime=0).items():ec.codes_set(g,k,v)
            ec.codes_set_values(g,np.full(1440*721,99000.0));data=ec.codes_get_message(g)
        finally:ec.codes_release(g)
        pressure,lats,lons=m.read_grib(data,BASE,0)
        self.assertEqual(pressure.shape,(721,1440));self.assertEqual(pressure[0,0],990)
        with self.assertRaises(ValueError):m.read_grib(data,BASE-dt.timedelta(hours=6),0)
        with self.assertRaises(ValueError):m.read_grib(data[:-3],BASE,0)

    @unittest.skipUnless(NATIVE,'native decoders verified on Ubuntu')
    def test_sd3_native_axis_is_not_directory_initialization_and_units_stay_raw(self):
        from netCDF4 import Dataset
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'track.nc'
            with Dataset(path,'w') as f:
                f.createDimension('time',3);t=f.createVariable('time','i8',('time',));t.units='hours since 2026-10-17 18:00:00';t.calendar='proleptic_gregorian';t[:]=[0,6,12]
                for k,unit,values in [('lat','degree_north',[13,14,15]),('lon','degree_east',[145,144,143]),('mslp','hPa',[980,978,975]),('vmax','m/s',[38.5,40,42])]:
                    v=f.createVariable(k,'f8',('time',));v.units=unit;v[:]=values
                f.license='CC BY-NC 4.0'
            r=m.parse_sd3(path.read_bytes(),'typhoon-track/2026/10/20261017/12z/tc_WNP_CHAMPI_track.nc')
        self.assertEqual(r['directoryRun'],'2026-10-17T12:00:00Z');self.assertEqual(r['timeOrigin'],'2026-10-17T18:00:00Z');self.assertEqual(r['points'][0]['windMs'],38.5);self.assertEqual(r['points'][1]['validTime'],'2026-10-18T00:00:00Z')
        self.assertEqual(r['license'],'CC BY-NC 4.0');self.assertNotIn('atcfId',r)

if __name__=='__main__':unittest.main()
