import importlib.util
import io
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
        self.log.write_text('[yt-dlp] transient failure; retrying after 30s\n' * 20)
        self.assertFalse(vpn.health(self.lane))
        with self.log.open('a') as f:
            f.write('[yt-dlp] rate limited; pausing new requests for 240s\n' * 6)
        self.assertTrue(vpn.health(self.lane))
        with self.log.open('a') as f:
            f.write('[creator] [4] paired-saved\n')
        self.assertFalse(vpn.health(self.lane))
        self.assertEqual(self.lane['failures'], 0)

    def test_partial_lines_and_no_double_count(self):
        self.log.write_text('[yt-dlp] rate limited; pausing new re')
        self.assertFalse(vpn.health(self.lane))
        with self.log.open('a') as f:
            f.write('quests for 240s\n')
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

    def test_probe_uses_cheap_youtube_endpoint_inside_namespace(self):
        with patch.object(vpn.Path, 'exists', return_value=True), patch.object(vpn.subprocess, 'run') as run:
            run.return_value.stdout = '204'
            self.assertTrue(vpn.probe('uncensored-vpn-nl-free-237'))
            cmd = run.call_args.args[0]
            self.assertEqual(cmd[:6], ['sudo', '-n', 'ip', 'netns', 'exec', 'uncensored-vpn-nl-free-237'])
            self.assertIn('https://www.youtube.com/generate_204', cmd)
            self.assertNotIn('yt-dlp', cmd)

    def cycle(self, healthy, probe_result, **extra):
        (self.root / 'logs').mkdir()
        (self.root / 'report.json').write_text('{"queueComplete": false}')
        config = dict(namespaces=['uncensored-vpn-old', 'uncensored-vpn-new'], lanes=[self.lane], **extra)
        events = []
        cwd = Path.cwd()
        try:
            with patch.object(vpn, 'health', return_value=not healthy), patch.object(vpn, 'workers', side_effect=lambda *_: [] if ('stop', 42) in events else [42]), patch.object(vpn, 'processes', return_value={}), patch.object(vpn, 'namespace', return_value='uncensored-vpn-old'), patch.object(vpn, 'probe_result', return_value=('ok' if probe_result else 'infrastructure') if not isinstance(probe_result, list) else None, side_effect=[('ok' if r else 'infrastructure') for r in probe_result] if isinstance(probe_result, list) else None) as probe, patch.object(vpn, 'stop_tree', side_effect=lambda pid: events.append(('stop', pid))), patch.object(vpn, 'start', side_effect=lambda lane, ns: events.append(('start', ns))), patch.object(vpn.time, 'sleep', side_effect=InterruptedError):
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

    def test_failed_route_at_tunnel_cap_releases_then_rotates(self):
        # The cap blocks preparing a cold route while the worker holds its tunnel.
        with patch.object(vpn, 'prepare_namespace', side_effect=[False, True]), \
                patch.object(vpn.subprocess, 'run', return_value=Mock(returncode=0, stdout='')) as run:
            events, probes = self.cycle(False, [False, True], manageNamespaces=True)
        self.assertEqual(events, [('stop', 42), ('start', 'uncensored-vpn-new')])
        self.assertEqual(probes, 2)
        self.assertEqual(run.call_args.args[0][1:], ['cleanup-one', 'OLD'])

    def test_repeat_failure_after_in_place_restart_rotates(self):
        self.lane['inPlace'] = 'uncensored-vpn-old'  # already restarted in place on this route
        with patch.object(vpn, 'prepare_namespace', side_effect=[False, True]), \
                patch.object(vpn.subprocess, 'run', return_value=Mock(returncode=0, stdout='')):
            events, probes = self.cycle(False, [True], manageNamespaces=True)
        self.assertEqual(events, [('stop', 42), ('start', 'uncensored-vpn-new')])
        self.assertEqual(probes, 1)  # the failed current route is not probed again

    def test_worker_429_rotates_despite_passing_probe(self):
        self.lane['blocked'] = True
        with patch.object(vpn, 'prepare_namespace', side_effect=[False, True]), \
                patch.object(vpn.subprocess, 'run', return_value=Mock(returncode=0, stdout='')):
            events, probes = self.cycle(False, [True], manageNamespaces=True)
        self.assertEqual(events, [('stop', 42), ('start', 'uncensored-vpn-new')])
        self.assertEqual(probes, 1)  # the blocked current route is not probed in place

    def test_429_failure_marks_lane_blocked(self):
        with self.log.open('a') as stream:
            stream.write('[yt-dlp] rate limited; pausing new requests for 240s\n')
        vpn.health(self.lane)
        self.assertFalse(self.lane.get('blocked'))
        with self.log.open('a') as stream:
            stream.write('[yt-dlp] rate limited; pausing new requests for 240s (HTTP 429)\n')
        vpn.health(self.lane)
        self.assertTrue(self.lane['blocked'])

    def test_waiting_queue_obeys_worker_cap(self):
        (self.root / 'logs').mkdir()
        (self.root / 'report.json').write_text('{"queueComplete": false}')
        (self.root / 'waiting.json').write_text('{"queueComplete": false}')
        waiting = dict(self.lane, args=[a.replace('report.json', 'waiting.json').replace('ledger.json', 'waiting-ledger.json') for a in self.lane['args']])
        config = dict(namespaces=['uncensored-vpn-old'], lanes=[self.lane, waiting], maxWorkers=1)
        cwd = Path.cwd()
        try:
            with patch.object(vpn, 'health', return_value=False), patch.object(vpn, 'processes', return_value={}), patch.object(vpn, 'workers', side_effect=lambda lane, procs: [42] if lane is self.lane else []), patch.object(vpn, 'probe_result') as probe, patch.object(vpn, 'start') as start, patch.object(vpn.time, 'sleep', side_effect=InterruptedError):
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
            with patch.object(vpn, 'health', return_value=False), patch.object(vpn, 'processes', return_value={}), patch.object(vpn, 'workers', return_value=[]), patch.object(vpn, 'probe_result', return_value='ok'), patch.object(vpn, 'start') as start, patch.object(vpn.time, 'sleep', side_effect=InterruptedError):
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
        with patch.object(vpn, 'health', return_value=False), patch.object(vpn, 'processes', return_value={}), patch.object(vpn, 'workers', return_value=[]), patch.object(vpn, 'probe_result', return_value='ok'), patch.object(vpn, 'start', side_effect=launch) as start, patch.object(vpn.time, 'sleep', side_effect=InterruptedError):
            with self.assertRaises(InterruptedError):
                vpn.monitor(config)
            start.assert_called_once_with(self.lane, 'uncensored-vpn-old')

    def test_first_exhausted_request_triggers_recovery(self):
        self.log.write_text('[yt-dlp] transient failure; retrying after 30s\n')
        self.assertFalse(vpn.health(self.lane))
        with self.log.open('a') as stream:
            stream.write('[yt-dlp] rate limited; pausing new requests for 240s\n')
        self.assertTrue(vpn.health(self.lane))

    def test_listing_success_resets_exhausted_failures(self):
        self.lane['failures'] = 6
        self.log.write_text('[creator] list ytsearch:test: 20 listed, 10 new\n')
        self.assertFalse(vpn.health(self.lane))
        self.assertEqual(self.lane['failures'], 0)

    def test_probe_classifies_status_codes(self):
        for status, expected in [('204', 'ok'), ('429', 'blocked'), ('000', 'infrastructure'), ('503', 'infrastructure')]:
            with self.subTest(status=status), patch.object(vpn.Path, 'exists', return_value=True), \
                    patch.object(vpn.subprocess, 'run') as run:
                run.return_value.stdout = status
                self.assertEqual(vpn.probe_result('uncensored-vpn-test'), expected)
            self.assertEqual(vpn.route_delay(expected), 1800 if expected == 'blocked' else 60)

    def test_failed_setup_backs_off_before_retrying(self):
        allowed = ['uncensored-vpn-dead']
        vpn.setup_failures.clear()
        with patch.object(vpn.Path, 'exists', return_value=False), patch.object(vpn.Path, 'glob', return_value=[]), \
                patch.object(vpn.subprocess, 'run', return_value=Mock(returncode=1)) as run, patch.object(vpn, 'log'):
            self.assertFalse(vpn.prepare_namespace('uncensored-vpn-dead', allowed))
            self.assertFalse(vpn.prepare_namespace('uncensored-vpn-dead', allowed))
            self.assertEqual(run.call_count, 1)  # the second attempt is skipped during backoff
        self.assertEqual(vpn.setup_failures['uncensored-vpn-dead'][0], 1)
        vpn.setup_failures.clear()

    def test_missing_namespace_is_not_a_bad_route(self):
        with patch.object(vpn.Path, 'exists', return_value=False), \
                patch.object(vpn.subprocess, 'Popen') as popen:
            self.assertEqual(vpn.probe_result('uncensored-vpn-missing'), 'unavailable')
            popen.assert_not_called()

    def test_busy_current_namespace_is_not_removed(self):
        with patch.object(vpn, 'prepare_namespace', return_value=False), \
                patch.object(vpn.subprocess, 'run', return_value=Mock(returncode=0, stdout='99\n')) as run:
            events, probes = self.cycle(False, False, manageNamespaces=True)
        self.assertEqual(events, [('stop', 42)])
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0][-2:], ['pids', 'uncensored-vpn-old'])
        self.assertLessEqual(self.lane['next'] - time.monotonic(), 30)

    def test_route_cooldowns_and_capacity_retry_timing(self):
        (self.root / 'report.json').write_text('{"queueComplete": false}')
        for result, available, expected in [
            ('infrastructure', True, [100, 160]),
            ('blocked', True, [100]),
            ('unavailable', False, []),
        ]:
            with self.subTest(result=result):
                clock, probes, setups = [100], [], []
                def sleep(_):
                    clock[0] += 30
                    if clock[0] > 160:
                        raise InterruptedError
                def prepare(*_):
                    setups.append(clock[0])
                    return available
                def probe(_):
                    probes.append(clock[0])
                    return result
                config = dict(namespaces=['uncensored-vpn-new'], lanes=[self.lane], manageNamespaces=True)
                with patch.object(vpn, 'workers', return_value=[]), \
                        patch.object(vpn, 'processes', return_value={}), \
                        patch.object(vpn, 'health', return_value=False), \
                        patch.object(vpn, 'prepare_namespace', side_effect=prepare), \
                        patch.object(vpn, 'probe_result', side_effect=probe), \
                        patch.object(vpn.time, 'monotonic', side_effect=lambda: clock[0]), \
                        patch.object(vpn.time, 'sleep', side_effect=sleep):
                    with self.assertRaises(InterruptedError):
                        vpn.monitor(config)
                self.assertEqual(probes, expected)
                if not available:
                    self.assertEqual(setups, [100, 130, 160])

    def test_recovered_worker_is_not_stopped_at_tunnel_cap(self):
        (self.root / 'report.json').write_text('{"queueComplete": false}')
        config = dict(namespaces=['uncensored-vpn-old', 'uncensored-vpn-new'],
                      lanes=[self.lane], manageNamespaces=True)
        with patch.object(vpn, 'workers', return_value=[42]), \
                patch.object(vpn, 'processes', return_value={}), \
                patch.object(vpn, 'namespace', return_value='uncensored-vpn-old'), \
                patch.object(vpn, 'health', side_effect=[True, False]), \
                patch.object(vpn, 'prepare_namespace', return_value=False), \
                patch.object(vpn, 'probe_result', return_value='infrastructure'), \
                patch.object(vpn, 'stop_tree') as stop, \
                patch.object(vpn.subprocess, 'run') as run, \
                patch.object(vpn.time, 'sleep', side_effect=InterruptedError):
            with self.assertRaises(InterruptedError):
                vpn.monitor(config)
            stop.assert_not_called()
            run.assert_not_called()

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
            self.assertLessEqual(self.lane['next'] - time.monotonic(), 30)
        self.assertEqual(json.loads((self.root / 'ledger.json').read_text()), {'preserved': True})


if __name__ == '__main__':
    unittest.main()
