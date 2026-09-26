import importlib.util
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location('vpn', Path(__file__).resolve().parents[1] / 'tools/supervise-caption-vpn.py')
vpn = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vpn)


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.root_patch = patch.object(vpn, 'ROOT', self.root)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)
        self.log = self.root / 'worker.log'
        self.log.write_text('')
        self.lane = dict(log='worker.log', offset=0, failures=0, pending='', args=[
            'node', 'tools/download-paired-captions.js', '--manual-auto-only', 'true',
            '--jobs', '1', '--audio-target', '0', '--config', 'config.json',
            '--report', 'report.json', '--checked-ledger', 'ledger.json'])

    def test_semantic_failures_do_not_rotate(self):
        self.log.write_text('Video unavailable\nno-manual\nno-allowed-words\n' * 20)
        self.assertFalse(vpn.health(self.lane))

    def test_repeated_network_failures_and_recovery(self):
        self.log.write_text('[yt-dlp] transient failure; retrying after 30s\n' * 6)
        self.assertTrue(vpn.health(self.lane))
        with self.log.open('a') as f:
            f.write('[creator] [4] paired-saved\n')
        self.assertFalse(vpn.health(self.lane))
        self.assertEqual(self.lane['failures'], 0)

    def test_partial_lines_and_no_double_count(self):
        self.log.write_text('transient fail')
        self.assertFalse(vpn.health(self.lane))
        with self.log.open('a') as f:
            f.write('ure\n')
        vpn.health(self.lane)
        vpn.health(self.lane)
        self.assertEqual(self.lane['failures'], 1)

    def test_hung_log(self):
        with patch.object(vpn.time, 'time', return_value=time.time() + 1300):
            self.assertTrue(vpn.health(self.lane))

    def test_explicit_separate_modes_and_unique_ledgers(self):
        config = dict(namespaces=['uncensored-vpn-nl-free-237'], lanes=[self.lane])
        vpn.validate(config)
        for other in [dict(config, namespaces=['default']), dict(config, lanes=[self.lane, self.lane])]:
            with self.assertRaises(AssertionError):
                vpn.validate(other)
        self.lane['args'] += ['--synthetic-auto-only', 'true']
        with self.assertRaises(AssertionError):
            vpn.validate(config)

    def test_state_paths_must_be_distinct_after_resolution(self):
        config = dict(namespaces=['uncensored-vpn-nl-free-237'], lanes=[self.lane])
        aliased = dict(self.lane, args=[
            f'sub/../{arg}' if arg in ('report.json', 'ledger.json') else arg
            for arg in self.lane['args']
        ])
        # The paths differ textually but resolve to the same file.
        config['lanes'] = [self.lane, aliased]
        with self.assertRaises(AssertionError):
            vpn.validate(config)

    def test_refuse_duplicate_before_start(self):
        with patch.object(vpn, 'workers', return_value=[42]), patch.object(vpn, 'processes', return_value={}):
            with self.assertRaises(RuntimeError):
                vpn.start(self.lane, 'uncensored-vpn-nl-free-237')

    def test_on_demand_setup_preserves_busy_tunnels(self):
        allowed = ['uncensored-vpn-new', 'uncensored-vpn-busy']
        with patch.object(vpn.Path, 'exists', autospec=True, side_effect=lambda p: p.name.endswith('busy')), patch.object(vpn.Path, 'glob', return_value=[Path('one'), Path('two')]), patch.object(vpn.subprocess, 'run', return_value=Mock(returncode=0, stdout='42\n')) as run:
            self.assertFalse(vpn.prepare_namespace(allowed[0], allowed))
            self.assertEqual(run.call_count, 1)
            self.assertEqual(run.call_args.args[0][-2:], ['pids', allowed[1]])

    def test_on_demand_reclaims_only_idle_then_sets_up(self):
        allowed = ['uncensored-vpn-new', 'uncensored-vpn-idle']
        with patch.object(vpn.Path, 'exists', autospec=True, side_effect=lambda p: p.name.endswith('idle')), patch.object(vpn.Path, 'glob', return_value=[]), patch.object(vpn.subprocess, 'run', return_value=Mock(returncode=0, stdout='')) as run:
            self.assertTrue(vpn.prepare_namespace(allowed[0], allowed))
            commands = [call.args[0] for call in run.call_args_list]
            self.assertEqual(commands[1][-2:], ['cleanup-one', 'IDLE'])
            self.assertEqual(commands[2][-2:], ['setup-one', 'NEW'])
            self.assertFalse(any('nmcli' in c for c in commands))
        with self.assertRaises(ValueError):
            vpn.prepare_namespace('unapproved', allowed)

    def test_existing_namespace_is_not_recreated(self):
        with patch.object(vpn.Path, 'exists', return_value=True), patch.object(vpn.subprocess, 'run') as run:
            self.assertTrue(vpn.prepare_namespace('uncensored-vpn-ok', ['uncensored-vpn-ok']))
            run.assert_not_called()

    def test_probe_requires_caption_body_not_homepage(self):
        with patch.object(vpn.Path, 'exists', return_value=True), patch.object(vpn.subprocess, 'run', return_value=Mock(returncode=0)) as run:
            self.assertFalse(vpn.probe('uncensored-vpn-nl-free-237'))
            cmd = run.call_args.args[0]
            self.assertEqual(cmd[:6], ['sudo', '-n', 'ip', 'netns', 'exec', 'uncensored-vpn-nl-free-237'])
            self.assertIn('--write-auto-subs', cmd)
            self.assertIn('--ignore-config', cmd)
            self.assertNotIn('test-fixtures', ' '.join(cmd))

    def cycle(self, healthy, probe_result):
        (self.root / 'logs').mkdir()
        (self.root / 'report.json').write_text('{"queueComplete": false}')
        config = dict(namespaces=['uncensored-vpn-old', 'uncensored-vpn-new'], lanes=[self.lane])
        events = []
        cwd = Path.cwd()
        try:
            with patch.object(vpn, 'health', return_value=not healthy), patch.object(vpn, 'workers', return_value=[42]), patch.object(vpn, 'processes', return_value={}), patch.object(vpn, 'namespace', return_value='uncensored-vpn-old'), patch.object(vpn, 'probe', return_value=probe_result if not isinstance(probe_result, list) else None, side_effect=probe_result if isinstance(probe_result, list) else None) as probe, patch.object(vpn, 'stop_tree', side_effect=lambda pid: events.append(('stop', pid))), patch.object(vpn, 'start', side_effect=lambda lane, ns: events.append(('start', ns))), patch.object(vpn.time, 'sleep', side_effect=InterruptedError):
                with self.assertRaises(InterruptedError):
                    vpn.main(config)
                return events, probe.call_count
        finally:
            vpn.os.chdir(cwd)

    def test_adopts_healthy_worker_without_probe_or_restart(self):
        self.assertEqual(self.cycle(True, True), ([], 0))

    def test_no_working_route_preserves_worker(self):
        self.assertEqual(self.cycle(False, False), ([], 2))

    def test_healthy_current_route_recovers_stuck_worker_in_place(self):
        self.assertEqual(self.cycle(False, [False, True]),
                         ([('stop', 42), ('start', 'uncensored-vpn-old')], 2))

    def test_verified_failover_stops_before_resuming(self):
        events, probes = self.cycle(False, True)
        self.assertEqual(events, [('stop', 42), ('start', 'uncensored-vpn-new')])
        self.assertEqual(probes, 1)

    def test_waiting_queue_obeys_worker_cap(self):
        (self.root / 'logs').mkdir()
        (self.root / 'report.json').write_text('{"queueComplete": false}')
        (self.root / 'waiting.json').write_text('{"queueComplete": false}')
        waiting = dict(self.lane, args=[a.replace('report.json', 'waiting.json').replace('ledger.json', 'waiting-ledger.json') for a in self.lane['args']])
        config = dict(namespaces=['uncensored-vpn-old'], lanes=[self.lane, waiting], maxWorkers=1)
        cwd = Path.cwd()
        try:
            with patch.object(vpn, 'health', return_value=False), patch.object(vpn, 'processes', return_value={}), patch.object(vpn, 'workers', side_effect=lambda lane, procs: [42] if lane is self.lane else []), patch.object(vpn, 'probe') as probe, patch.object(vpn, 'start') as start, patch.object(vpn.time, 'sleep', side_effect=InterruptedError):
                with self.assertRaises(InterruptedError):
                    vpn.main(config)
                probe.assert_not_called()
                start.assert_not_called()
                self.assertLess(waiting['turn'], self.lane['turn'])
        finally:
            vpn.os.chdir(cwd)

    def test_queue_exit_releases_stale_launch_reservation(self):
        (self.root / 'logs').mkdir()
        (self.root / 'report.json').write_text('{"queueComplete": true}')
        waiting = dict(self.lane, args=[a.replace('report.json', 'waiting.json').replace('ledger.json', 'waiting-ledger.json') for a in self.lane['args']])
        (self.root / 'waiting.json').write_text('{"queueComplete": false}')
        config = dict(namespaces=['uncensored-vpn-old'], lanes=[self.lane, waiting], maxWorkers=1)
        self.lane['launchUntil'] = time.monotonic() + 300
        cwd = Path.cwd()
        try:
            with patch.object(vpn, 'health', return_value=False), patch.object(vpn, 'processes', return_value={}), patch.object(vpn, 'workers', return_value=[]), patch.object(vpn, 'probe', return_value=True), patch.object(vpn, 'start') as start, patch.object(vpn.time, 'sleep', side_effect=InterruptedError):
                with self.assertRaises(InterruptedError):
                    vpn.main(config)
                start.assert_called_once_with(waiting, 'uncensored-vpn-old')
                self.assertEqual(self.lane['launchUntil'], 0)
        finally:
            vpn.os.chdir(cwd)

    def test_launch_reservation_blocks_second_invisible_worker(self):
        (self.root / 'report.json').write_text('{"queueComplete": false}')
        (self.root / 'waiting.json').write_text('{"queueComplete": false}')
        waiting = dict(self.lane, args=[a.replace('report.json', 'waiting.json').replace('ledger.json', 'waiting-ledger.json') for a in self.lane['args']])
        config = dict(namespaces=['uncensored-vpn-old'], lanes=[self.lane, waiting], maxWorkers=1)
        def launch(lane, ns):
            lane['launchUntil'] = time.monotonic() + 30
            return Mock()
        with patch.object(vpn, 'health', return_value=False), patch.object(vpn, 'processes', return_value={}), patch.object(vpn, 'workers', return_value=[]), patch.object(vpn, 'probe', return_value=True), patch.object(vpn, 'start', side_effect=launch) as start, patch.object(vpn.time, 'sleep', side_effect=InterruptedError):
            with self.assertRaises(InterruptedError):
                vpn.monitor(config)
            start.assert_called_once_with(self.lane, 'uncensored-vpn-old')

    def test_invalid_worker_limit_rejected(self):
        with self.assertRaises(AssertionError):
            vpn.validate(dict(namespaces=['uncensored-vpn-old'], lanes=[self.lane], maxWorkers=0))

    def test_start_retains_argv_and_saved_state(self):
        for file in ['config.json', 'report.json', 'ledger.json']:
            (self.root / file).write_text('{"preserved": true}')
        child = Mock(pid=42)
        with patch.object(vpn, 'workers', return_value=[]), patch.object(vpn, 'processes', return_value={}), patch.object(vpn.subprocess, 'Popen', return_value=child) as popen:
            vpn.start(self.lane, 'uncensored-vpn-nl-free-237')
            cmd = popen.call_args.args[0]
            self.assertEqual(cmd[-len(self.lane['args']):], self.lane['args'])
            self.assertEqual(cmd[:6], ['sudo', '-n', 'ip', 'netns', 'exec', 'uncensored-vpn-nl-free-237'])
            self.assertTrue(popen.call_args.kwargs['start_new_session'])
            self.assertGreater(self.lane['launchUntil'], time.monotonic())
        self.assertEqual(json.loads((self.root / 'ledger.json').read_text()), {'preserved': True})


if __name__ == '__main__':
    unittest.main()
