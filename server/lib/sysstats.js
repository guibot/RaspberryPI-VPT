'use strict';
// Estatísticas do sistema (CPU %, GPU % e temperatura) para o HUD de depuração do player.
// Calculadas a pedido: cada chamada compara com a anterior; chamadas muito próximas devolvem o valor em cache.
const fs = require('fs');

const MIN_INTERVAL_MS = 800;

function cpuTimes() {
  const f = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  return { total: f.reduce((a, b) => a + b, 0), idle: f[3] + (f[4] || 0) };
}

// Tempo ocupado (ns) do motor de render do V3D, somado por cliente DRM (lido de /proc/<pid>/fdinfo).
function gpuRenderNs() {
  const seen = new Set();
  let ns = 0;
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter(p => /^\d+$/.test(p)); } catch { return null; }
  for (const pid of pids) {
    let fds;
    try { fds = fs.readdirSync(`/proc/${pid}/fdinfo`); } catch { continue; }
    for (const fd of fds) {
      let t;
      try { t = fs.readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8'); } catch { continue; }
      if (!t.includes('drm-driver:\tv3d')) continue;
      const id = (t.match(/drm-client-id:\s*(\d+)/) || [])[1];
      const key = pid + ':' + id;
      if (seen.has(key)) continue;
      seen.add(key);
      const m = t.match(/drm-engine-render:\s*(\d+)\s*ns/);
      if (m) ns += Number(m[1]);
    }
  }
  return ns;
}

function temperature() {
  try { return Number(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8')) / 1000; } catch { return null; }
}

let prev = null;
let cached = { cpu: null, gpu: null, temp: null };

function sample() {
  const now = Date.now();
  if (prev && now - prev.t < MIN_INTERVAL_MS) return cached;
  const cpu = cpuTimes();
  const gpu = gpuRenderNs();
  if (prev) {
    const dCpu = cpu.total - prev.cpu.total;
    const dWall = (now - prev.t) * 1e6;                       // ms -> ns
    cached = {
      cpu: dCpu > 0 ? Math.round(100 * (1 - (cpu.idle - prev.cpu.idle) / dCpu)) : null,
      gpu: gpu != null && prev.gpu != null ? Math.min(100, Math.round(100 * (gpu - prev.gpu) / dWall)) : null,
      temp: temperature() != null ? Math.round(temperature() * 10) / 10 : null,
    };
  } else {
    cached = { cpu: null, gpu: null, temp: temperature() };
  }
  prev = { t: now, cpu, gpu };
  return cached;
}

module.exports = { sample };
