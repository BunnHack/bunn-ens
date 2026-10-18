import base64
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch
import numpy as np

spec = importlib.util.spec_from_file_location('variables_wm6', Path(__file__).resolve().parents[1] / 'scripts/wm6_forecast.py')
wm6 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wm6)
RUN = {'initialization_time': '2026-10-18T05:00:00Z', 'forecast_zero': '2026-10-18T00:00:00Z'}


class ForecastVariableTests(unittest.TestCase):
    def test_exhausted_total_quota_fails_once_without_retrying_or_exposing_body(self):
        response = MagicMock(status_code=429, content=b'{"error":"Quota exceeded"}')
        response.json.return_value = {'error': 'Quota exceeded', 'message': 'Free trial is limited to 2000 total requests. You have used 2000.'}
        session = MagicMock()
        session.get.return_value = response
        with patch.object(wm6, '_next_api_request', 0), patch.object(wm6.time, 'sleep') as sleep:
            with self.assertRaisesRegex(RuntimeError, 'total request quota exhausted'):
                wm6.request(session, '/run_information')
        session.get.assert_called_once()
        response.close.assert_called_once()
        sleep.assert_not_called()

    def test_native_field_names_levels_and_nine_distinct_products(self):
        self.assertEqual(len(wm6.PRODUCTS), 9)
        self.assertEqual(len({p['id'] for p in wm6.PRODUCTS}), 9)
        self.assertEqual(wm6.FIELDS['t850'], ('temperature', 850))
        self.assertEqual(wm6.FIELDS['wind250'], ('wind_speed', 250))
        self.assertEqual(wm6.FIELDS['dewpoint'], ('dewpoint_2m', None))
        self.assertEqual(wm6.FIELDS['tcwv'], ('total_column_water_vapour', None))
        for product in ['dewpoint', 'cape', 'tcwv', 'temperature850', 'wind250']:
            self.assertEqual(len(wm6.REQUIRED[product]), 1)

    def test_verified_native_units_are_only_explicit_display_conversions(self):
        np.testing.assert_allclose(wm6.convert_field([273.15, 300], 'K', 'dewpoint'), [0, 26.85])
        np.testing.assert_allclose(wm6.convert_field([263.15, 293.15], 'K', 't850'), [-10, 20])
        np.testing.assert_array_equal(wm6.convert_field([0, 1250.125], 'J kg-1', 'cape'), [0, 1250.125])
        np.testing.assert_array_equal(wm6.convert_field([0, 43.625], 'kg m-2', 'tcwv'), [0, 43.625])
        np.testing.assert_allclose(wm6.convert_field([10, 70], 'm s-1', 'wind250'), np.array([10, 70])*3600/1852)
        for key, unit in [('cape', 'mm'), ('tcwv', 'mm'), ('dewpoint', 'C'), ('t850', 'C'), ('wind250', 'kt')]:
            with self.assertRaises(ValueError):
                wm6.convert_field([1], unit, key)

    def test_v3_upgrade_preserves_original_provider_pin_instead_of_mixing_new_hourly_versions(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            record = {'id': '20261018T0300Z', 'initializationTime': '2026-10-18T03:00:00Z', 'forecastZero': RUN['forecast_zero'], 'generatorVersion': 'native-zarr-v3-time', 'frames': []}
            (out / 'runs' / record['id']).mkdir(parents=True)
            self.assertIs(wm6.cached_forecast_base({'runs': [record]}, RUN['forecast_zero'], out), record)
            self.assertFalse(wm6.base_assets_complete(record, {0, 6}, out))
            self.assertIsNone(wm6.cached_forecast_base({'runs': [{**record, 'generatorVersion': 'unknown'}]}, RUN['forecast_zero'], out))

    @unittest.skipUnless(importlib.util.find_spec('zarr'), 'Native Zarr test runs on Ubuntu Actions')
    def test_real_zarr_reader_keeps_native_fields_and_refuses_implicit_zero_chunks_and_wrong_statistics(self):
        import zarr
        fields = {'dewpoint': ('dewpoint_2m', 'K', 290.125), 'cape': ('cape', 'J kg-1', 1250.125), 'tcwv': ('total_column_water_vapour', 'kg m-2', 43.625), 't850': ('temperature_850', 'K', 280.125), 'wind250': ('wind_speed_250', 'm s-1', 43.625)}
        with tempfile.TemporaryDirectory() as directory:
            group = zarr.open_group(directory, mode='w')
            group.attrs.update({**RUN, 'forecast_hour': 0, 'model': 'WM 6 Global'})
            group.create_array('latitude', data=np.array([10., 20.]))
            group.create_array('longitude', data=np.array([140., 150.]))
            mean = group.create_group('ensemble_mean')
            for name, unit, value in fields.values():
                array = mean.create_array(name, data=np.ones((2, 2))*value)
                array.attrs.update({'units': unit, 'product_type': 'ensemble_mean'})

            def payload(exclude=''):
                return {'url': 'https://example.r2.cloudflarestorage.com/signed', 'parts': [{'path': str(path.relative_to(directory)), 'inline': base64.b64encode(path.read_bytes()).decode()} for path in Path(directory).rglob('*') if path.is_file() and str(path.relative_to(directory)) != exclude]}

            def read(value):
                response = MagicMock()
                response.__enter__.return_value.json.return_value = value
                with patch.object(wm6, 'request', return_value=response) as request:
                    result = wm6.download_archive_fields(None, RUN, 0, list(fields))
                    self.assertEqual(request.call_args.args[2]['variable'], 'all')
                    self.assertEqual(request.call_args.args[2]['initialization_time'], RUN['initialization_time'])
                return result

            result = read(payload())
            self.assertEqual(set(result), set(fields))
            for key, (_, unit, value) in fields.items():
                np.testing.assert_allclose(result[key][2], np.ones((2, 2))*wm6.convert_field([value], unit, key)[0])
            missing = read(payload('ensemble_mean/cape/c/0/0'))
            self.assertNotIn('cape', missing)
            self.assertEqual(len(missing), 4)
            mean['wind_speed_250'].attrs['product_type'] = 'ensemble_std'
            invalid = read(payload())
            self.assertNotIn('wind250', invalid)
            self.assertIn('cape', invalid)
            group.attrs['forecast_hour'] = 6
            with self.assertRaises(ValueError):
                read(payload())


if __name__ == '__main__':
    unittest.main()
