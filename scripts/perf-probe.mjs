// scripts/perf-probe.mjs — M12-04 node-side perf probe (docs/design/
// M12-plan.md §M12-04a). ONE command: measures the three fixed scripted
// scenes (E1M7 heaviest / E1M1 baseline / 40-mobj firefight) IN THIS
// PROCESS behind a V8 CPU profiler (node:inspector Profiler.start/stop —
// one profile, exactly the profiled work, no vitest-runner noise), then
// commits the evidence: measured table (node-results.json), raw profile
// (profiles/probe.cpuprofile), and the flame SUMMARY (flame-summary.md —
// top self-time frames, engine frames flagged, so a budget violation gets
// hot-path attribution for the wave-3 fix task without a devtools session).
//
// The engine loads through vite's ssr module runner (same TS, same module
// graph the vitest gate runs — tests/perf/probe-entry.ts is the shared
// body; perf.test.ts asserts the same budget). Exit != 0 on a violation
// (the entry throws with the violating cells listed).
//
// Usage: node scripts/perf-probe.mjs [--out=tests/perf/evidence]
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outArg = process.argv.slice(2).find((a) => a.startsWith('--out='));
const OUT = resolve(ROOT, outArg ? outArg.slice(6) : 'tests/perf/evidence');
const PROFILES = join(OUT, 'profiles');

rmSync(PROFILES, { recursive: true, force: true });
mkdirSync(PROFILES, { recursive: true });

/* 1. engine in-process (vite SSR runner — the vitest-transform twin)    */

const server = await createServer({
  root: ROOT,
  configFile: false,
  logLevel: 'warn',
  server: { middlewareMode: true },
  appType: 'custom'
});
try {
  const entry = await server.ssrLoadModule('/tests/perf/probe-entry.ts');

  /* 2. profile ONLY the measured region                                 */

  const session = new Session();
  session.connect();
  const post = (method, params) =>
    new Promise((res, rej) =>
      session.post(method, params, (err, out) => (err ? rej(err) : res(out)))
    );
  await post('Profiler.enable');
  await post('Profiler.setSamplingInterval', { interval: 200 }); // us
  await post('Profiler.start');
  let result;
  let probeError = null;
  try {
    result = entry.runProbe();
  } catch (err) {
    probeError = err;
  }
  const { profile } = await post('Profiler.stop');
  session.disconnect();
  writeFileSync(join(PROFILES, 'probe.cpuprofile'), JSON.stringify(profile));

  /* 3. self-time aggregation → flame-summary.md                         */

  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const agg = new Map();
  let totalMs = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const node = byId.get(profile.samples[i]);
    if (!node) continue;
    const dt = (profile.timeDeltas[i] ?? 0) / 1000; // us → ms
    const cf = node.callFrame;
    const url = shortUrl(cf.url);
    const key = `${cf.functionName || '(anon)'} @ ${url}:${cf.lineNumber ?? -1}`;
    const e = agg.get(key) ?? { selfMs: 0, engine: /[/\\]src[/\\]/.test(cf.url ?? '') };
    e.selfMs += dt;
    agg.set(key, e);
    totalMs += dt;
  }
  const rows = [...agg.entries()]
    .map(([fn, v]) => ({ fn, selfMs: v.selfMs, engine: v.engine }))
    .sort((a, b) => b.selfMs - a.selfMs);

  const lines = [
    '# M12-04 node probe — CPU profile flame summary',
    '',
    `Profile: profiles/probe.cpuprofile (${totalMs.toFixed(0)} ms sampled, 200 µs`,
    'interval; open in Chrome devtools → Performance). Regenerate:',
    '`node scripts/perf-probe.mjs`.',
    ''
  ];
  if (result) {
    lines.push('## Measured table (node, per scene)', '');
    lines.push('| scene | mobjs | sim p50/p95/max (ms) | render p50/p95/max (ms) | frame p50/p95 (ms) |');
    lines.push('|---|---|---|---|---|');
    for (const s of result.scenes) {
      lines.push(
        `| ${s.name} | ${s.mobjsAtBoot} | ${s.simP50.toFixed(2)} / ${s.simP95.toFixed(2)} / ${s.simMax.toFixed(2)} | ${s.renderP50.toFixed(2)} / ${s.renderP95.toFixed(2)} / ${s.renderMax.toFixed(2)} | ${s.frameP50.toFixed(2)} / ${s.frameP95.toFixed(2)} |`
      );
    }
    lines.push(
      '',
      `Budget ${JSON.stringify(result.budget)} — pinned per D-12a (tests/perf/budget.ts).`,
      `Machine: ${result.machine.cpu} (${result.machine.cores} cores), node ${result.machine.node}.`,
      ''
    );
  }
  lines.push('## Top self-time frames (✔ = repo engine frame)', '');
  lines.push('| % total | self ms | frame | engine |');
  lines.push('|---|---|---|---|');
  for (const r of rows.slice(0, 25)) {
    lines.push(
      `| ${((100 * r.selfMs) / totalMs).toFixed(1)} | ${r.selfMs.toFixed(1)} | \`${r.fn}\` | ${r.engine ? '✔' : ''} |`
    );
  }
  writeFileSync(join(OUT, 'flame-summary.md'), lines.join('\n') + '\n');

  if (result) {
    writeFileSync(join(OUT, 'node-results.json'), JSON.stringify(result, null, 2));
    console.log('measured:', result.scenes.map((s) => `${s.name} sim ${s.simP95.toFixed(2)} / render ${s.renderP95.toFixed(2)} (p95)`).join(' | '));
  }
  console.log(`probe evidence → ${OUT}`);
  if (probeError !== null) {
    console.error(String(probeError?.message ?? probeError));
    process.exitCode = 1;
  }
} finally {
  await server.close();
}

function shortUrl(url) {
  if (!url) return '(native)';
  const s = url.replace(/^file:\/\//, '').replace(ROOT + '/', '');
  return s.length > 72 ? `…${s.slice(-71)}` : s;
}
