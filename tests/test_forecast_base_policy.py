import copy
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import MagicMock, patch
from PIL import Image

spec = importlib.util.spec_from_file_location('base_wm6', Path(__file__).resolve().parents[1] / 'scripts/wm6_forecast.py')
wm6 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wm6)
ZERO = '2026-10-17T06:00:00Z'


def upstream(version='2026-10-17T10:00:00Z', zero=ZERO):
    return {'initialization_time': version, 'forecast_zero': zero, 'in_progress': False, 'available': [{'forecast_hour': hour} for hour in [0, 3, 6]]}


def response(value):
    result = MagicMock()
    result.__enter__.return_value.json.return_value = value
    return result


def published(out, hours=(0, 6)):
    record = {'id': '20261017T0900Z', 'initializationTime': '2026-10-17T09:00:00Z', 'forecastZero': ZERO, 'generatorVersion': wm6.GENERATOR_VERSION, 'generatedAt': '2026-10-17T10:40:54Z', 'frames': []}
    for hour in hours:
        frame = {'hour': hour, 'validTime': wm6.iso(wm6.utc(ZERO) + wm6.timedelta(hours=hour)), 'files': {}}
        for region in wm6.REGIONS:
            files = frame['files'][region['id']] = {}
            for product in wm6.PRODUCTS:
                if not hour and product['id'] == 'precip':
                    continue
                prefix = f"runs/{record['id']}/{region['id']}/{product['id']}/{hour:03d}"
                target = out / (prefix + '.png')
                target.parent.mkdir(parents=True, exist_ok=True)
                Image.new('RGB', (4, 2), 'blue').save(target)
                (out / (prefix + '.svgz')).write_bytes(b'verified-test-svg')
                files[product['id']] = {'png': prefix + '.png', 'svg': prefix + '.svgz'}
        record['frames'].append(frame)
    (out / 'index.json').write_text(json.dumps({'runs': [record]}))
    return record


def args(out, force=False):
    return SimpleNamespace(initialization='latest', max_hour=6, hours='', output=str(out), force=force)


class ForecastBasePolicyTests(unittest.TestCase):
    def test_complete_base_is_not_regenerated_for_newer_hourly_provider_and_publication_stays_identical(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'WM_API_KEY': 'unit-only'}):
            out = Path(directory)
            record = published(out)
            before = (out / 'index.json').read_bytes()
            with patch.object(wm6, 'request', return_value=response(upstream())) as request, patch.object(wm6, 'download_archive_fields') as grids, patch.object(wm6, 'render_chart') as render:
                self.assertFalse(wm6.generate(args(out)))
            self.assertEqual(request.call_count, 1)
            grids.assert_not_called()
            render.assert_not_called()
            self.assertEqual(before, (out / 'index.json').read_bytes())
            self.assertEqual(record['initializationTime'], '2026-10-17T09:00:00Z')

    def test_completeness_requires_all_requested_products_regions_valid_times_and_nonempty_safe_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            record = published(out)
            self.assertTrue(wm6.base_assets_complete(record, {0, 6}, out))
            self.assertFalse(wm6.base_assets_complete(record, {0, 6, 12}, out))
            bad = copy.deepcopy(record)
            bad['frames'][1]['validTime'] = '2026-10-17T16:00:00Z'
            self.assertFalse(wm6.base_assets_complete(bad, {6}, out))
            bad = copy.deepcopy(record)
            bad['frames'][1]['files']['east-asia']['wind']['png'] = '../private.png'
            self.assertFalse(wm6.base_assets_complete(bad, {6}, out))
            target = out / record['frames'][1]['files']['east-asia']['wind']['png']
            target.write_bytes(b'')
            self.assertFalse(wm6.base_assets_complete(record, {6}, out))
            target.unlink()
            self.assertFalse(wm6.base_assets_complete(record, {6}, out))
            self.assertIsNone(wm6.cached_forecast_base({'runs': [record]}, '2026-10-17T12:00:00Z', out))
            bad = copy.deepcopy(record)
            bad['generatorVersion'] = 'older-format'
            self.assertIsNone(wm6.cached_forecast_base({'runs': [bad]}, ZERO, out))

    def test_partial_repair_pins_original_provider_and_failed_repair_does_not_refresh_publication(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'WM_API_KEY': 'unit-only'}):
            out = Path(directory)
            published(out, (0,))
            before = (out / 'index.json').read_bytes()
            with patch.object(wm6, 'request', side_effect=[response(upstream()), response(upstream('2026-10-17T09:00:00Z'))]) as request, patch.object(wm6, 'download_archive_fields', side_effect=RuntimeError('Unavailable field')) as grids, patch.object(wm6, 'build_animations') as animations:
                self.assertFalse(wm6.generate(args(out)))
            self.assertEqual(request.call_args_list[1].args[2]['initialization_time'], '2026-10-17T09:00:00Z')
            self.assertEqual(grids.call_args.args[1]['initialization_time'], '2026-10-17T09:00:00Z')
            self.assertEqual(grids.call_args.args[2], 6)
            animations.assert_not_called()
            self.assertEqual(before, (out / 'index.json').read_bytes())

    def test_pinned_metadata_conflict_aborts_without_replacing_any_published_manifest(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'WM_API_KEY': 'unit-only'}):
            out = Path(directory)
            published(out, (0,))
            before = (out / 'index.json').read_bytes()
            with patch.object(wm6, 'request', side_effect=[response(upstream()), response(upstream('2026-10-17T09:00:00Z', '2026-10-17T00:00:00Z'))]), patch.object(wm6, 'download_archive_fields') as grids:
                with self.assertRaisesRegex(ValueError, 'metadata mismatch'):
                    wm6.generate(args(out))
            grids.assert_not_called()
            self.assertEqual(before, (out / 'index.json').read_bytes())

    def test_new_base_and_explicit_force_are_not_hidden_by_a_same_base_cache(self):
        for latest, force in [(upstream('2026-10-17T13:00:00Z', '2026-10-17T12:00:00Z'), False), (upstream(), True)]:
            with self.subTest(force=force), tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'WM_API_KEY': 'unit-only'}):
                out = Path(directory)
                published(out)
                before = (out / 'index.json').read_bytes()
                with patch.object(wm6, 'request', return_value=response(latest)), patch.object(wm6, 'download_archive_fields', side_effect=RuntimeError('Unavailable field')) as grids:
                    with self.assertRaisesRegex(RuntimeError, 'No real charts generated'):
                        wm6.generate(args(out, force))
                self.assertEqual(grids.call_count, 2)
                self.assertEqual(grids.call_args.args[1]['initialization_time'], latest['initialization_time'])
                self.assertEqual(before, (out / 'index.json').read_bytes())

    def test_new_base_publishes_one_pinned_version_with_distinct_base_history_then_skips_hourly_replacement(self):
        import numpy as np
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'WM_API_KEY': 'unit-only'}):
            out = Path(directory)
            published(out)
            latest = upstream('2026-10-17T13:00:00Z', '2026-10-17T12:00:00Z')
            field = (np.array([10, 20]), np.array([140, 150]), np.ones((2, 2)))
            def render(fields, region, product, run, hour, destination):
                self.assertEqual(run['initialization_time'], latest['initialization_time'])
                destination.parent.mkdir(parents=True, exist_ok=True)
                Image.new('RGB', (4, 2), 'red' if hour == 0 else 'green').save(destination.with_suffix('.png'))
                destination.with_suffix('.svgz').write_bytes(b'verified-test-svg')
            with patch.object(wm6, 'request', return_value=response(latest)), patch.object(wm6, 'download_archive_fields', side_effect=lambda session, run, hour, keys: {key: field for key in keys}), patch.object(wm6, 'download_field', return_value=field), patch.object(wm6, 'render_chart', side_effect=render):
                self.assertTrue(wm6.generate(args(out)))
            manifest = json.loads((out / 'index.json').read_text())
            self.assertEqual([item['forecastZero'] for item in manifest['runs']], ['2026-10-17T12:00:00Z', ZERO])
            self.assertEqual([item['id'] for item in manifest['runs']], ['20261017T1300Z', '20261017T0900Z'])
            self.assertTrue(wm6.base_assets_complete(manifest['runs'][0], {0, 6}, out))
            self.assertEqual(manifest['runs'][0]['frames'][1]['validTime'], '2026-10-17T18:00:00Z')
            before = (out / 'index.json').read_bytes()
            with patch.object(wm6, 'request', return_value=response(upstream('2026-10-17T14:00:00Z', '2026-10-17T12:00:00Z'))), patch.object(wm6, 'download_archive_fields') as grids:
                self.assertFalse(wm6.generate(args(out)))
            grids.assert_not_called()
            self.assertEqual(before, (out / 'index.json').read_bytes())

    def test_workflow_only_saves_cache_after_successful_publication_and_skips_unchanged_uploads(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/wm6-forecast-charts.yml').read_text()
        self.assertIn('actions/cache/restore@v4', workflow)
        self.assertIn('actions/cache/save@v4', workflow)
        self.assertIn("steps.deployment.outcome == 'success'", workflow)
        self.assertGreaterEqual(workflow.count("if: steps.charts.outputs.changed == 'true'"), 4)
        self.assertIn('id: charts', workflow)
        self.assertIn('Probe availability hourly', workflow)
        source = (Path(__file__).resolve().parents[1] / 'scripts/wm6_forecast.py').read_text()
        self.assertIn("os.environ['GITHUB_OUTPUT']", source)
        self.assertIn("changed={'true' if changed else 'false'}", source)


if __name__ == '__main__':
    unittest.main()
