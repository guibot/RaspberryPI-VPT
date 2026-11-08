#!/usr/bin/env python3
"""Executor da Fase 0: serve a página de teste, lança o Chromium por cenário e mede CPU/temperatura/throttling.

Uso: run.py <cenário>[,<cenário>...] [--dur 120] [--warm 8] [--flags "..."] [--out results.jsonl]
Cenário: modo:n:vid   ex.: dom:4:640x480_30fps   webgl:12:800x600_30fps
"""
import argparse, http.server, json, os, shutil, signal, subprocess, threading, time, socketserver

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = {'stats': {}, 'start': threading.Event(), 'result': None, 'done': threading.Event()}
ENV = dict(os.environ, XDG_RUNTIME_DIR=f'/run/user/{os.getuid()}', WAYLAND_DISPLAY='wayland-0')


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=HERE, **k)
    def log_message(self, *a): pass
    def end_headers(self): self.send_header('Cache-Control', 'no-store'); super().end_headers()
    def do_GET(self):
        if self.path.startswith('/stats'):
            b = json.dumps(STATE['stats']).encode()
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
        else: super().do_GET()
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)) or 0)
        if self.path == '/start': STATE['start'].set()
        elif self.path == '/result': STATE['result'] = json.loads(body); STATE['done'].set()
        self.send_response(204); self.end_headers()


class Srv(socketserver.ThreadingMixIn, http.server.HTTPServer): daemon_threads = True; allow_reuse_address = True


def cpu_times():
    f = [int(x) for x in open('/proc/stat').readline().split()[1:]]
    return sum(f), f[3] + f[4]            # total, idle+iowait


def gpu_ns():
    """Soma do tempo ocupado (ns) dos motores bin e render do V3D, por cliente DRM (via fdinfo)."""
    seen, bin_ns, render_ns = set(), 0, 0
    for pid in os.listdir('/proc'):
        if not pid.isdigit(): continue
        try:
            for fd in os.listdir(f'/proc/{pid}/fdinfo'):
                try: t = open(f'/proc/{pid}/fdinfo/{fd}').read()
                except OSError: continue
                if 'drm-driver:\tv3d' not in t: continue
                d = dict(l.split(':', 1) for l in t.splitlines() if ':' in l)
                key = (pid, d.get('drm-client-id', '').strip())
                if key in seen: continue
                seen.add(key)
                bin_ns += int(d['drm-engine-bin'].split()[0]); render_ns += int(d['drm-engine-render'].split()[0])
        except OSError: continue
    return bin_ns, render_ns


def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True).stdout.strip()


def sample():
    t = float(sh('vcgencmd measure_temp').split('=')[1].rstrip("'C"))
    thr = int(sh('vcgencmd get_throttled').split('=')[1], 16)
    freq = int(open('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq').read()) // 1000
    return t, thr, freq


def run_scenario(spec, dur, warm, flags, port, shot, layout=''):
    mode, n, vid = spec.split(':')
    tag = f'{mode}-{n}-{vid}'
    STATE.update(result=None); STATE['start'].clear(); STATE['done'].clear()
    prof = f'/tmp/p0-profile-{os.getpid()}'; shutil.rmtree(prof, ignore_errors=True)
    url = f'http://127.0.0.1:{port}/test.html?mode={mode}&n={n}&vid={vid}&dur={dur}&warm={warm}&tag={tag}' + (f'&layout={layout}' if layout else '')
    cmd = ['chromium', f'--user-data-dir={prof}', '--ozone-platform=wayland', '--kiosk', '--no-first-run',
           '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', '--noerrdialogs',
           '--disable-infobars', '--disable-session-crashed-bubble', '--password-store=basic', *flags, url]
    p = subprocess.Popen(cmd, env=ENV, start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    samples, res = [], None
    try:
        if not STATE['start'].wait(90): raise RuntimeError('a página não arrancou')
        t_end = time.time() + dur; c0 = cpu_times(); g0 = (time.time(), *gpu_ns()); shot_done = False; t_start = time.time()
        while time.time() < t_end + 30 and not STATE['done'].is_set():
            time.sleep(1)
            c1 = cpu_times(); busy = 100 * (1 - (c1[1] - c0[1]) / max(1, c1[0] - c0[0])); c0 = c1
            g1 = (time.time(), *gpu_ns()); w = (g1[0] - g0[0]) * 1e9
            gb, gr = 100 * (g1[1] - g0[1]) / w, 100 * (g1[2] - g0[2]) / w; g0 = g1
            t, thr, f = sample(); samples.append((busy, t, thr, f, gb, gr))
            STATE['stats'] = {'cpu': round(busy), 'gpu': round(gr), 'temp': t}
            if shot and not shot_done and time.time() - t_start > 6:
                subprocess.run(['grim', f'{shot}/{tag}.png'], env=ENV); shot_done = True
        STATE['done'].wait(10); res = STATE['result']
    finally:
        try: os.killpg(p.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        time.sleep(2)
        try: os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError: pass
    if res is None: return {'tag': tag, 'error': 'sem resultado'}
    cpu = [s[0] for s in samples]; gr = [s[5] for s in samples]; gb = [s[4] for s in samples]
    res.update(gpu_render_avg=round(sum(gr) / len(gr), 1), gpu_render_max=round(max(gr), 1), gpu_bin_avg=round(sum(gb) / len(gb), 1),
               cpu_avg=round(sum(cpu) / len(cpu), 1), cpu_max=round(max(cpu), 1),
               temp_start=samples[0][1], temp_max=max(s[1] for s in samples),
               throttled_flags=hex(max(s[2] for s in samples)), min_freq_mhz=min(s[3] for s in samples))
    return res


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('scenarios'); ap.add_argument('--dur', type=int, default=120); ap.add_argument('--warm', type=int, default=8)
    ap.add_argument('--flags', default=''); ap.add_argument('--out', default=os.path.join(HERE, 'results.jsonl'))
    ap.add_argument('--layout', default=''); ap.add_argument('--label', default='1080p'); ap.add_argument('--shots', default=os.path.join(HERE, 'shots'))
    a = ap.parse_args()
    os.makedirs(a.shots, exist_ok=True)
    srv = Srv(('127.0.0.1', 0), H); port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    for spec in a.scenarios.split(','):
        print(f'>> {spec} ({a.label}, {a.dur}s)', flush=True)
        r = run_scenario(spec, a.dur, a.warm, a.flags.split(), port, a.shots, a.layout)
        r['label'] = a.label; r['flags'] = a.flags
        open(a.out, 'a').write(json.dumps(r) + '\n')
        print(json.dumps({k: v for k, v in r.items() if k != 'per_video'}), flush=True)
        time.sleep(20)       # arrefecer um pouco entre cenários
