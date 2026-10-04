#!/usr/bin/env python3
"""Linux caption-worker supervisor. Never activates host VPN connections.

Usage: python tools/supervise-caption-vpn.py CONFIG.json
Config: {namespaces: ["uncensored-vpn-..."], lanes: [{args: ["node",
"tools/download-paired-captions.js", ...], log: "logs/lane.log"}]}.
Optional manageNamespaces:true uses the local whitelisted setup helper on demand,
with a two-tunnel cap; only idle namespaces may be removed.
Stopping this supervisor leaves download workers running. One supervisor per project.
"""
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
FAILURE = re.compile(r"transient failure|rate limited|HTTP Error (?:429|50[234])|Sign in to confirm", re.I)
SUCCESS = re.compile(r"\] \[\d+\] (?:paired-saved|no-censored-slots|no-allowed-words|no-manual|no-automatic)\b")
COOLDOWN = 1800


def log(message):
    print(time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), message, flush=True)


def option(args, name):
    return args[args.index(name) + 1]


def validate(config):
    assert config['namespaces'] and len(set(config['namespaces'])) == len(config['namespaces'])
    assert all(re.fullmatch(r'uncensored-vpn-[a-z0-9-]+', n) for n in config['namespaces'])
    state_paths = set()
    for lane in config['lanes']:
        args = lane['args']
        assert args[:2] == ['node', 'tools/download-paired-captions.js']
        modes = ['--manual-auto-only', '--synthetic-auto-only', '--auto-auto-only']
        assert sum(m in args and option(args, m) == 'true' for m in modes) == 1
        assert option(args, '--jobs') == '1' and option(args, '--audio-target') == '0'
        report, ledger = option(args, '--report'), option(args, '--checked-ledger')
        report_path = (ROOT / report).resolve()
        ledger_path = (ROOT / ledger).resolve()
        assert report_path != ledger_path
        assert report_path not in state_paths and ledger_path not in state_paths
        state_paths.update((report_path, ledger_path))
        assert lane['log']
    assert state_paths
    assert type(config.get('maxWorkers', len(config['lanes']))) is int
    assert config.get('maxWorkers', len(config['lanes'])) > 0


def processes():
    result = {}
    for p in Path('/proc').iterdir():
        if not p.name.isdigit():
            continue
        try:
            stat = (p / 'stat').read_text().split(') ')[1].split()
            if stat[0] != 'Z':
                result[int(p.name)] = (int(stat[1]), stat[19],
                    (p / 'cmdline').read_bytes().decode().strip('\0').split('\0'))
        except (OSError, UnicodeError, IndexError):
            pass
    return result


def workers(lane, procs):
    report = str((ROOT / option(lane['args'], '--report')).resolve())
    found = []
    for pid, (_, _, args) in procs.items():
        if len(args) < 2 or Path(args[0]).name != 'node' or '--report' not in args:
            continue
        try:
            cwd = Path(f'/proc/{pid}/cwd').resolve()
            if cwd != ROOT or Path(args[1]).name != 'download-paired-captions.js':
                continue
            if str((cwd / option(args, '--report')).resolve()) == report:
                if args != lane['args']:
                    raise RuntimeError(f'PID {pid}: queue arguments changed; refusing takeover')
                found.append(pid)
        except FileNotFoundError:
            continue
    if len(found) > 1:
        raise RuntimeError('Multiple writers: refusing rotation')
    return found


def namespace(pid, allowed):
    inode = os.stat(f'/proc/{pid}/ns/net').st_ino
    return next((n for n in allowed if Path('/run/netns', n).exists()
                 and os.stat(Path('/run/netns', n)).st_ino == inode), None)


def stop_tree(pid):
    # Snapshot identities: never signal a recycled PID or unrelated worker.
    procs = processes()
    tree = {pid}
    while True:
        more = {p for p, (parent, _, _) in procs.items() if parent in tree}
        if more <= tree:
            break
        tree |= more
    identities = {p: procs[p][1] for p in tree if p in procs}
    for sig in [signal.SIGTERM, signal.SIGKILL]:
        for p, identity in identities.items():
            current = processes().get(p)
            if current and current[1] == identity:
                os.kill(p, sig)
        deadline = time.monotonic() + (30 if sig == signal.SIGTERM else 5)
        while time.monotonic() < deadline:
            current = processes()
            if not any(p in current and current[p][1] == identity for p, identity in identities.items()):
                return
            time.sleep(1)
    raise RuntimeError('Old worker descendants still active; refusing restart')


def health(lane):
    path = ROOT / lane['log']
    if not path.exists():
        return False
    size = path.stat().st_size
    if size < lane['offset']:
        lane['offset'] = 0
    with path.open('rb') as stream:
        stream.seek(lane['offset'])
        chunk = stream.read()
        lane['offset'] = stream.tell()
    lane['pending'] += chunk.decode(errors='replace')
    lines = lane['pending'].split('\n')
    lane['pending'] = lines.pop()
    for line in lines:
        if FAILURE.search(line):
            lane['failures'] += 1
        elif SUCCESS.search(line):
            lane['failures'] = 0
    # Enough time for downloader retries and its own 240-second backoff.
    return lane['failures'] >= 6 or time.time() - path.stat().st_mtime > 1200


def prepare_namespace(ns, allowed):
    if ns not in allowed:
        raise ValueError('Namespace is not allowed')
    if Path('/run/netns', ns).exists():
        return True
    helper = ROOT / 'tmp/isolated-vpn-netns.sh'
    # Reclaim only idle, explicitly allowed tunnels. Never remove a worker's route.
    for other in allowed:
        if not Path('/run/netns', other).exists():
            continue
        pids = subprocess.run(['sudo', '-n', 'ip', 'netns', 'pids', other],
                              capture_output=True, text=True)
        if pids.returncode == 0 and not pids.stdout.strip():
            subprocess.run([str(helper), 'cleanup-one', other.removeprefix('uncensored-vpn-').upper()],
                           check=True)
    if len(list(Path('/run/netns').glob('uncensored-vpn-*'))) >= 2:
        log('Two tunnels already active; not disturbing busy namespaces')
        return False
    return subprocess.run([str(helper), 'setup-one', ns.removeprefix('uncensored-vpn-').upper()]).returncode == 0


def probe(ns):
    if not Path('/run/netns', ns).exists():
        return False
    # Download an actual known English track, never into the fixture directory.
    with tempfile.TemporaryDirectory(prefix='caption-vpn-') as directory:
        cmd = ['sudo', '-n', 'ip', 'netns', 'exec', ns, 'runuser', '-u', 'lasu', '--',
               'timeout', '--kill-after=5s', '100s', 'yt-dlp', '--ignore-config',
               '--socket-timeout', '15', '--retries', '0', '--extractor-retries', '0',
               '--skip-download', '--write-auto-subs', '--sub-langs', 'en-orig',
               '--sub-format', 'json3', '--no-playlist', '-o', directory + '/probe.%(ext)s',
               'https://www.youtube.com/watch?v=XUqDddNo_FM']
        # timeout runs inside the namespace and kills its entire probe process group.
        result = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            body = json.loads(Path(directory, 'probe.en-orig.json3').read_text())
            return result.returncode == 0 and any(e.get('segs') for e in body.get('events', []))
        except (OSError, ValueError):
            return False


def start(lane, ns):
    if workers(lane, processes()):
        raise RuntimeError('Writer appeared during probe; refusing duplicate')
    # Reject damaged saved state rather than resetting progress.
    for flag in ['--config', '--report', '--checked-ledger']:
        json.loads((ROOT / option(lane['args'], flag)).read_text())
    cmd = ['sudo', '-n', 'ip', 'netns', 'exec', ns, 'runuser', '-u', 'lasu', '--'] + lane['args']
    with (ROOT / lane['log']).open('ab', buffering=0) as stream:
        stream.write(f'\n=== Automatic VPN resume via {ns}; saved report/ledger retained ===\n'.encode())
        child = subprocess.Popen(cmd, cwd=ROOT, stdin=subprocess.DEVNULL,
                                 stdout=stream, stderr=stream, start_new_session=True)
    Path(ROOT / lane['log']).with_suffix('.pid').write_text(str(child.pid) + '\n')
    lane['offset'] = (ROOT / lane['log']).stat().st_size
    lane['failures'], lane['pending'] = 0, ''
    lane['next'] = time.monotonic() + COOLDOWN
    lane['turn'] = time.monotonic()
    lane['launchUntil'] = time.monotonic() + 30
    log(f"Resumed {option(lane['args'], '--report')} via {ns}; launcher {child.pid}")
    return child


def main(config):
    os.chdir(ROOT)
    validate(config)
    with open(ROOT / 'logs/caption-vpn-supervisor.lock', 'a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        lock.seek(0)
        lock.truncate()
        lock.write(str(os.getpid()))
        lock.flush()
        monitor(config)


def monitor(config):
    cooldown, children = {}, []
    for lane in config['lanes']:
        size = (ROOT / lane['log']).stat().st_size
        offset = max(0, size - 8192) if config.get('inspectRecentLogOnStart') is True else size
        lane.update(offset=offset, failures=0, pending='', next=0,
                    turn=time.monotonic() if workers(lane, processes()) else 0)
    log('Monitoring existing workers; no startup interruption. Worker-only namespaces; '
        f'on-demand setup={config.get("manageNamespaces") is True}.')
    while True:
        children[:] = [c for c in children if c.poll() is None]
        for lane in sorted(config['lanes'], key=lambda lane: lane['turn']):
            try:
                unhealthy = health(lane)
                procs = processes()
                pids = workers(lane, procs)
                if (pids and not unhealthy) or time.monotonic() < lane['next']:
                    continue
                report = json.loads((ROOT / option(lane['args'], '--report')).read_text())
                if report.get('queueComplete') is True:
                    # A worker can finish its queue before the launch guard expires.
                    # Do not let that stale reservation hold the global cap hostage.
                    if not pids:
                        lane['launchUntil'] = 0
                    continue
                if not pids:
                    running = sum(bool(workers(other, procs)) or
                                  time.monotonic() < other.get('launchUntil', 0)
                                  for other in config['lanes'])
                    if running >= config.get('maxWorkers', len(config['lanes'])):
                        continue
                current = namespace(pids[0], config['namespaces']) if pids else None
                if pids and not current:
                    raise RuntimeError('Worker outside allowed namespaces; refusing takeover')
                lane['next'] = time.monotonic() + COOLDOWN
                if current:
                    cooldown[current] = time.monotonic() + COOLDOWN
                target, unavailable = None, set()
                for ns in config['namespaces']:
                    if ns == current or cooldown.get(ns, 0) > time.monotonic():
                        continue
                    if config.get('manageNamespaces') is True and not prepare_namespace(ns, config['namespaces']):
                        cooldown[ns] = time.monotonic() + COOLDOWN
                        unavailable.add(ns)
                        log(f'{ns}: namespace unavailable; deferring (not a YouTube rate-limit result)')
                        continue
                    log(f'Testing captions through {ns}')
                    if probe(ns):
                        target = ns
                        break
                    cooldown[ns] = time.monotonic() + COOLDOWN
                    log(f'{ns}: caption probe failed; cooling down')
                if not target and current:
                    # At the two-tunnel account cap, break-before-make cannot safely
                    # probe a cold alternate. A healthy current route can still
                    # recover a downloader stuck in its own rate-limit/backoff state.
                    log(f'Testing current route {current} for in-place recovery')
                    if probe(current):
                        target = current
                        log(f'{current}: route healthy; restarting only the unhealthy worker')
                if not target and current and pids and config.get('manageNamespaces') is True:
                    # The current route failed and the cap blocks a cold alternate: release the
                    # unhealthy (resumable) worker and its tunnel, then break before make.
                    log(f'{current}: route failed; releasing it to rotate at the tunnel cap')
                    stop_tree(pids[0])
                    pids = []
                    helper = ROOT / 'tmp/isolated-vpn-netns.sh'
                    subprocess.run([str(helper), 'cleanup-one', current.removeprefix('uncensored-vpn-').upper()],
                                   check=True)
                    for ns in config['namespaces']:
                        # Routes that only failed setup at the cap are untested, not rate limited.
                        if ns == current or (cooldown.get(ns, 0) > time.monotonic() and ns not in unavailable):
                            continue
                        if prepare_namespace(ns, config['namespaces']) and probe(ns):
                            target = ns
                            break
                        cooldown[ns] = time.monotonic() + COOLDOWN
                        log(f'{ns}: unavailable or caption probe failed; cooling down')
                if not target:
                    log('No verified route; retaining existing workers and backing off 30 minutes')
                    continue
                # Recheck after slow probes: do not stop a worker that recovered.
                if pids and not health(lane):
                    log('Worker recovered during probe; leaving it running')
                    continue
                if workers(lane, processes()) != pids:
                    raise RuntimeError('Writer changed during probe; deferring')
                if pids:
                    stop_tree(pids[0])
                children.append(start(lane, target))
            except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
                log(f'Safe deferral: {error}')
                lane['next'] = time.monotonic() + COOLDOWN
        time.sleep(30)


if __name__ == '__main__':
    main(json.loads(Path(sys.argv[1]).read_text()))
