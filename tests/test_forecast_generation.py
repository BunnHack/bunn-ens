import importlib.util
import io
import gzip
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, MagicMock

import numpy as np

MODULE = Path(__file__).resolve().parents[1] / 'scripts/wm6_forecast.py'
spec = importlib.util.spec_from_file_location('wm6_forecast', MODULE)
wm6 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wm6)
RUN = {'initialization_time': '2026-10-17T03:00:00Z', 'forecast_zero': '2026-10-17T00:00:00Z'}


class ForecastTests(unittest.TestCase):
    def test_physical_units_and_no_guessed_conversion(self):
        np.testing.assert_allclose(wm6.convert_field([100000], b'Pa', 'pressure_msl'), [1000])
        np.testing.assert_allclose(wm6.convert_field([wm6.G*5600], 'm2 s-2', 'z500'), [560])
        np.testing.assert_allclose(wm6.convert_field([273.15, 300], 'K', 'temperature_2m'), [0, 26.85])
        np.testing.assert_allclose(wm6.convert_field([10], 'm/s', 'wind_speed_10m'), [19.4384449244])
        with self.assertRaises(ValueError):
            wm6.convert_field([64], 'kt', 'wind_speed_10m')
        with self.assertRaises(ValueError):
            wm6.convert_field([1], 'm', 'precip')

    def test_six_hour_rate_uses_adjacent_accumulations(self):
        np.testing.assert_allclose(wm6.precipitation_rate([3, 12], [9, 0]), [2, 2])
        self.assertEqual(wm6.iso(wm6.utc(RUN['forecast_zero']) + wm6.timedelta(hours=12)), '2026-10-17T12:00:00Z')
        self.assertNotEqual(wm6.utc(RUN['forecast_zero']), wm6.utc(RUN['initialization_time']))

    def test_reject_run_model_anchor_hour_mismatches(self):
        attrs = {**RUN, 'forecast_hour': np.array([12]), 'model': 'wm-6'}
        wm6.verify_metadata(attrs, RUN, 12)
        for change in [{'model': 'gfs'}, {'forecast_hour': 15}, {'forecast_zero': '2026-10-17T03:00:00Z'}, {'initialization_time': '2026-10-17T04:00:00Z'}]:
            with self.assertRaises(ValueError):
                wm6.verify_metadata({**attrs, **change}, RUN, 12)

    def test_sorted_longitudes_and_latitudes_keep_data_identity(self):
        lat = np.array([20, 10]); lon = np.array([-120, -110, 140, 150])
        data = np.array([[1, 2, 3, 4], [5, 6, 7, 8]])
        x, y, values = wm6.regional_grid((lat, lon, data), {'bounds': [130, 160, 0, 30]})
        np.testing.assert_array_equal(x, [140, 150]); np.testing.assert_array_equal(y, [10, 20])
        np.testing.assert_array_equal(values, [[7, 8], [3, 4]])
        x, _, values = wm6.regional_grid((lat, lon, data), {'bounds': [-140, -100, 0, 30]})
        np.testing.assert_array_equal(x, [-120, -110]); np.testing.assert_array_equal(values, [[5, 6], [1, 2]])

    def test_pressure_centers_are_real_interior_extrema_with_raw_hpa(self):
        x = np.linspace(100, 140, 81); y = np.linspace(0, 40, 81)
        xx, yy = np.meshgrid(x, y)
        p = 1010-25*np.exp(-((xx-110)**2+(yy-10)**2)/9)+25*np.exp(-((xx-130)**2+(yy-30)**2)/9)
        original = p.copy()
        centers = wm6.pressure_centers(x, y, p)
        self.assertEqual({c['kind'] for c in centers}, {'H', 'L'})
        for center in centers:
            col = np.where(x == center['lon'])[0][0]; row = np.where(y == center['lat'])[0][0]
            self.assertEqual(center['pressure_hpa'], p[row, col])
        np.testing.assert_array_equal(p, original)
        self.assertAlmostEqual(next(c['pressure_hpa'] for c in centers if c['kind']=='L'), 985)
        self.assertAlmostEqual(next(c['pressure_hpa'] for c in centers if c['kind']=='H'), 1035)

    def test_no_false_centers_for_plateaus_gradients_noise_or_cropped_edges(self):
        x = np.linspace(100, 140, 81); y = np.linspace(0, 40, 81); xx, yy = np.meshgrid(x, y)
        for values in [np.ones_like(xx)*1010, 1000+xx, 1010-30*np.exp(-((xx-100)**2+(yy-20)**2)/9), 1010-.2*np.exp(-((xx-120)**2+(yy-20)**2)/9)]:
            self.assertEqual(wm6.pressure_centers(x, y, values), [])
        values = 1010-25*np.exp(-((xx-110)**2+(yy-10)**2)/9)
        values[15:25, 15:25] = np.nan
        self.assertEqual(wm6.pressure_centers(x, y, values), [])

    def test_city_abbreviations_are_unique_and_not_station_claims(self):
        import json
        places = json.loads((wm6.ROOT / 'src/data/map-places.json').read_text())
        self.assertEqual(len({p['code'] for p in places}), len(places))
        self.assertTrue(all(p['code'].isascii() and p['code'].isupper() and p['enName'] for p in places))

    def test_render_all_four_products_as_actual_png_and_svg(self):
        lat = np.linspace(0, 65, 28); lon = np.linspace(70, 180, 44)
        xx, yy = np.meshgrid(lon, lat)
        fields = {key: (lat, lon, values) for key, values in {
            'pressure_msl': 1005+20*np.exp(-((xx-110)**2+(yy-40)**2)/36)-30*np.exp(-((xx-140)**2+(yy-20)**2)/45), 'z500': 570-yy*.4, 'z1000': np.zeros_like(xx),
            't500': -10-yy*.4, 'temperature_2m': 30-yy*.6,
            'wind_speed_10m': xx/4, 'precip': xx/20, 'previous_precip': yy/10,
        }.items()}
        from PIL import Image
        with tempfile.TemporaryDirectory() as temp:
            for product in wm6.PRODUCTS:
                dest = Path(temp) / product['id']
                wm6.render_chart(fields, wm6.REGIONS[0], product['id'], RUN, 12, dest)
                with Image.open(dest.with_suffix('.png')) as image:
                    self.assertEqual(image.size, (1820, 1300))
                    self.assertEqual(image.mode, 'P')
                    self.assertIn('forecast_zero', image.info['Description'])
                text = gzip.decompress(dest.with_suffix('.svgz').read_bytes()).decode()
                self.assertIn('128-member ensemble mean', text)
                self.assertIn('2026-10-17T12:00:00Z', text)
                self.assertIn('Generated by GitHub Actions', text)
                self.assertNotIn('GFS', text)
                self.assertIn('city-TPE', text)
                self.assertEqual('mslp-center-L' in text, product['id'] in ('precip', 'wind'))
                self.assertEqual('mslp-center-H' in text, product['id'] in ('precip', 'wind'))

    def test_rate_limit_retries_respect_delay_and_do_not_expose_response_body(self):
        limited = MagicMock(status_code=429, ok=False, headers={'Retry-After': '17'})
        success = MagicMock(status_code=200, ok=True)
        session = MagicMock(); session.get.side_effect = [limited, success]
        with patch.object(wm6, 'API_INTERVAL', 0), patch.object(wm6, '_next_api_request', 0), patch.object(wm6.time, 'sleep') as sleep:
            self.assertIs(wm6.request(session, '/gridded'), success)
            sleep.assert_called_once_with(17)
        session.get.side_effect = wm6.requests.Timeout('private diagnostic')
        with patch.object(wm6.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, '^WM-6 network request failed$'):
                wm6.request(session, '/gridded')

    def test_api_limiter_reserves_one_request_every_fifteen_seconds(self):
        response = MagicMock(status_code=200, ok=True)
        session = MagicMock(); session.get.return_value = response
        with patch.object(wm6, 'API_INTERVAL', 15), patch.object(wm6, '_next_api_request', 0), patch.object(wm6.time, 'monotonic', return_value=0), patch.object(wm6.time, 'sleep') as sleep:
            wm6.request(session, '/run_information'); wm6.request(session, '/gridded')
            sleep.assert_called_once_with(15)

    def test_archive_range_never_forwards_api_credentials_or_downloads_whole_zip(self):
        response = MagicMock(status_code=206, headers={'Content-Range': 'bytes 12-14/100'})
        response.__enter__.return_value = response; response.iter_content.return_value = [b'abc']
        with patch.object(wm6.requests, 'get', return_value=response) as get:
            self.assertEqual(wm6.archive_part('https://example.r2.cloudflarestorage.com/signed', {'range': [12, 14]}), b'abc')
            self.assertEqual(get.call_args.kwargs['headers'], {'Range': 'bytes=12-14'})
            self.assertTrue(get.call_args.kwargs['stream'])
        for value in [[-1, 0], [0, 2**32]]:
            with self.assertRaises(ValueError): wm6.archive_part('unused', {'range': value})

    @unittest.skipUnless(importlib.util.find_spec('zarr'), 'Native Zarr reader runs on Ubuntu Actions')
    def test_archive_reader_pins_run_and_decodes_only_requested_ensemble_mean_fields(self):
        import zarr
        import base64
        with tempfile.TemporaryDirectory() as directory:
            group = zarr.open_group(directory, mode='w')
            group.attrs.update({**RUN, 'forecast_hour': 12, 'model': 'WM 6 Global'})
            group.create_array('latitude', data=np.array([10., 20.])); group.create_array('longitude', data=np.array([140., 150.]))
            mean = group.create_group('ensemble_mean')
            array = mean.create_array('pressure_msl', data=np.ones((2, 2))*100000)
            array.attrs.update({'units': 'Pa', 'product_type': 'ensemble_mean'})
            parts = [{'path': str(path.relative_to(directory)), 'inline': base64.b64encode(path.read_bytes()).decode()} for path in Path(directory).rglob('*') if path.is_file()]
            response = MagicMock(); response.__enter__.return_value.json.return_value = {'url': 'https://example.r2.cloudflarestorage.com/signed', 'parts': parts}
            with patch.object(wm6, 'request', return_value=response) as request:
                fields = wm6.download_archive_fields(None, RUN, 12, ['pressure_msl'])
                np.testing.assert_allclose(fields['pressure_msl'][2], 1000)
                self.assertEqual(request.call_args.args[2]['initialization_time'], RUN['initialization_time'])
                self.assertEqual(request.call_args.args[2]['forecast_hour'], 12)
                self.assertEqual(request.call_args.args[2]['as_url'], 'true')

    def test_forecast_and_trend_gifs_only_use_matching_valid_times(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp)
            def frame(hour, valid, filename, color):
                Image.new('RGB', (40, 30), color).save(out / filename)
                return {'hour': hour, 'validTime': valid, 'files': {'east-asia': {'precip': {'png': filename}}}}
            record = {'id': 'new', 'frames': [frame(12, '2026-10-17T12:00:00Z', 'new12.png', 'red'), frame(18, '2026-10-17T18:00:00Z', 'new18.png', 'green')]}
            older = {'frames': [frame(18, '2026-10-17T12:00:00Z', 'old18.png', 'blue')]}
            wm6.build_animations(record, older, out)
            self.assertEqual(set(record['trends']['east-asia']['precip']), {'12'})
            for path in [record['animations']['east-asia']['precip'], record['trends']['east-asia']['precip']['12']]:
                with Image.open(out / path) as image:
                    self.assertEqual(image.n_frames, 2)

    @unittest.skipUnless(importlib.util.find_spec('h5py'), 'Native HDF5 reader runs on Ubuntu Actions')
    def test_native_netcdf_reader_enforces_units_metadata_and_pinning(self):
        import h5py
        payload = io.BytesIO()
        with h5py.File(payload, 'w') as f:
            f.attrs.update({**RUN, 'model': 'wm-6', 'forecast_hour': 12})
            f.create_dataset('latitude', data=[20, 10]); f.create_dataset('longitude', data=[140, 150])
            v = f.create_dataset('geopotential_500', data=np.ones((2, 2))*wm6.G*5600)
            v.attrs['units'] = 'm2 s-2'
        response = MagicMock(); response.__enter__.return_value.content = payload.getvalue()
        with patch.object(wm6, 'request', return_value=response) as request:
            _, _, values = wm6.download_field(None, RUN, 12, 'z500')
            np.testing.assert_allclose(values, 560)
            params = request.call_args.args[2]
            self.assertEqual(params['initialization_time'], RUN['initialization_time'])
            self.assertEqual(params['forecast_hour'], 12); self.assertEqual(params['level'], 500)
            self.assertNotIn('time', params)


if __name__ == '__main__':
    unittest.main()
