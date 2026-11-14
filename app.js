'use strict';
/* Factory Noise Meter — วัดเสียงจากไมโครโฟนด้วย Web Audio API
   เส้นทางสัญญาณ:  ไมค์/โหมดจำลอง → input → [A-weighting] → wAn  (ระดับ dB(A))
                                          → zAn                (ระดับ dB(Z), Lpeak)
                                          → sAn                (สเปกตรัมอ็อกเตฟ)  */

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const METER_MIN = 30, METER_MAX = 120;
const HIST_SECONDS = 120;
const TICK_MS = 100;
const BANDS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const BAND_LABEL = ['31.5', '63', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
const DOSE_PRESETS = {
  niosh:   { crit: 85, q: 3 },
  oshaHca: { crit: 85, q: 5 },
  oshaPel: { crit: 90, q: 5 },
};
const DOSE_FLOOR_DB = 70;   // ระดับต่ำกว่านี้ไม่นับเข้า Dose

/* ---------------- settings / storage ---------------- */
const DEFAULTS = {
  weighting: 'A', speed: 'F', cal: 100,
  warn: 80, limit: 85, danger: 90,
  dose: 'niosh', deviceId: '', wake: true,
  machine: '', state: '', point: '', dur: '30',
};

function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* private mode ฯลฯ */ }
}

let S = Object.assign({}, DEFAULTS, lsGet('noisemeter.settings', {}));
let LOG = lsGet('noisemeter.log', []);
const saveSettings = () => lsSet('noisemeter.settings', S);
const saveLog = () => lsSet('noisemeter.log', LOG);

/* ---------------- audio graph ---------------- */
const A = {
  ctx: null, input: null, wAn: null, zAn: null, sAn: null,
  bw: null, bz: null, bs: null,
  src: null, stream: null, demo: null,
  timer: null, last: 0, mode: null, wake: null,
};

/* A-weighting (IEC 61672) แบบ analog → bilinear (prewarp ที่ตำแหน่งขั้ว) เป็น biquad 3 ตัวต่อกัน */
function aWeightingSections(fs) {
  const c = 2 * fs;
  const pw = (f) => c * Math.tan((2 * Math.PI * f) / c);
  const w1 = pw(20.598997), w2 = pw(107.65265), w3 = pw(737.86223), w4 = pw(12194.217);
  const bil = (a, b) => {
    const [a2, a1, a0] = a, [b2, b1, b0] = b;
    const n = [a2 * c * c + a1 * c + a0, -2 * a2 * c * c + 2 * a0, a2 * c * c - a1 * c + a0];
    const d = [b2 * c * c + b1 * c + b0, -2 * b2 * c * c + 2 * b0, b2 * c * c - b1 * c + b0];
    return { ff: n.map((x) => x / d[0]), fb: d.map((x) => x / d[0]) };
  };
  return [
    bil([1, 0, 0], [1, 2 * w1, w1 * w1]),
    bil([1, 0, 0], [1, w2 + w3, w2 * w3]),
    bil([0, 0, 1], [1, 2 * w4, w4 * w4]),
  ];
}

function ensureGraph() {
  if (A.ctx) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx({ latencyHint: 'interactive' });
  A.ctx = ctx;
  A.input = ctx.createGain();

  const mk = (fft, smooth) => {
    const an = ctx.createAnalyser();
    an.fftSize = fft; an.smoothingTimeConstant = smooth;
    return an;
  };
  A.wAn = mk(8192, 0);
  A.zAn = mk(8192, 0);
  A.sAn = mk(8192, 0.5);

  const secs = aWeightingSections(ctx.sampleRate).map((s) => new IIRFilterNode(ctx, { feedforward: s.ff, feedback: s.fb }));
  // ทำให้ได้ 0 dB ที่ 1 kHz พอดี
  const f = new Float32Array([1000]), mag = new Float32Array(1), ph = new Float32Array(1);
  let g = 1;
  for (const s of secs) { s.getFrequencyResponse(f, mag, ph); g *= mag[0]; }
  const trim = ctx.createGain();
  trim.gain.value = 1 / g;

  A.input.connect(secs[0]);
  secs[0].connect(secs[1]); secs[1].connect(secs[2]); secs[2].connect(trim); trim.connect(A.wAn);
  A.input.connect(A.zAn);
  A.input.connect(A.sAn);
  A.aSecs = secs; A.aTrim = trim;

  A.bw = new Float32Array(A.wAn.fftSize);
  A.bz = new Float32Array(A.zAn.fftSize);
  A.bs = new Float32Array(A.sAn.frequencyBinCount);
}

/* ---------------- measurement state ---------------- */
let M, HIST, EVENTS, P = null;
let clipUntil = 0;
let lastText = 0, bandShown = new Array(BANDS.length).fill(0);

function newStats() {
  return {
    first: true, msW: 0, msZ: 0, T: 0, E: 0,
    lmax: -Infinity, lmin: Infinity, peak: -Infinity, hold: -Infinity, holdAt: 0,
    overT: 0, ep: null, dose: 0, L: null, rawDb: null,
  };
}
function resetStats() {
  M = newStats(); HIST = []; EVENTS = []; bandShown.fill(0);
  renderEvents(); updateStatsUI(true); drawHistory(); drawSpectrum(null);
}

const toDb = (ms) => Math.max(0, 10 * Math.log10(Math.max(ms, 1e-14)) + S.cal);
const doseCfg = () => DOSE_PRESETS[S.dose] || DOSE_PRESETS.niosh;
const allowedSeconds = (L) => { const { crit, q } = doseCfg(); return 28800 * Math.pow(2, (crit - L) / q); };

function zoneOf(L) {
  if (L >= S.danger) return { key: 'crit', text: 'อันตราย · ต้องสวมอุปกรณ์ป้องกันเสียง' };
  if (L >= S.limit)  return { key: 'bad',  text: 'เกินเกณฑ์ · จำกัดเวลาสัมผัส' };
  if (L >= S.warn)   return { key: 'warn', text: 'เฝ้าระวัง · ใกล้เกณฑ์' };
  return { key: 'ok', text: 'ปลอดภัย' };
}

/* ---------------- main tick ---------------- */
function tick() {
  if (!A.ctx) return;
  const now = performance.now();
  let dt = (now - A.last) / 1000;
  A.last = now;
  if (dt <= 0) return;
  dt = Math.min(dt, 1);

  A.wAn.getFloatTimeDomainData(A.bw);
  A.zAn.getFloatTimeDomainData(A.bz);

  const len = A.bw.length;
  const n = clamp(Math.round(dt * A.ctx.sampleRate), 16, len);
  let sw = 0, sz = 0, pk = 0;
  for (let i = len - n; i < len; i++) {
    const w = A.bw[i], z = A.bz[i];
    sw += w * w; sz += z * z;
    const az = Math.abs(z); if (az > pk) pk = az;
  }
  sw /= n; sz /= n;
  if (A.mode === 'mic' && pk >= 0.99) clipUntil = now + 4000;

  // time-weighting แบบเอ็กซ์โปเนนเชียล
  const tau = S.speed === 'S' ? 1 : 0.125;
  const k = 1 - Math.exp(-dt / tau);
  if (M.first) { M.msW = sw; M.msZ = sz; M.first = false; }
  else { M.msW += (sw - M.msW) * k; M.msZ += (sz - M.msZ) * k; }

  const useA = S.weighting === 'A';
  const msInst = useA ? sw : sz;
  const msExp = useA ? M.msW : M.msZ;
  const L = toDb(msExp);
  M.L = L;
  M.rawDb = 10 * Math.log10(Math.max(msExp, 1e-14));   // ก่อนบวก offset ใช้ตอนปรับเทียบ

  M.T += dt;
  M.E += msInst * dt;
  if (M.T > 0.4) { M.lmax = Math.max(M.lmax, L); M.lmin = Math.min(M.lmin, L); }
  const Lpk = toDb(pk * pk);
  M.peak = Math.max(M.peak, Lpk);

  // peak-hold ของแถบวัด (ค้าง 1.5 วินาที)
  if (L >= M.hold || now - M.holdAt > 1500) { M.hold = L; M.holdAt = now; }

  // เกินเกณฑ์ / เหตุการณ์
  if (L >= S.limit) {
    M.overT += dt;
    if (!M.ep) M.ep = { start: new Date(), dur: 0, max: L };
    M.ep.dur += dt; M.ep.max = Math.max(M.ep.max, L);
  } else if (M.ep && L < S.limit - 1) {
    closeEpisode();
  }

  // Dose
  if (L >= DOSE_FLOOR_DB) M.dose += dt / allowedSeconds(L);

  // ประวัติ
  HIST.push({ t: now, L });
  const cutoff = now - HIST_SECONDS * 1000;
  while (HIST.length && HIST[0].t < cutoff) HIST.shift();

  // จุดวัดที่กำลังบันทึก
  if (P) stepPoint(dt, msInst, L, Lpk);

  // สเปกตรัม
  A.sAn.getFloatFrequencyData(A.bs);
  const bands = computeBands(toDb(M.msZ));

  updateLive(L, now);
  drawHistory();
  drawSpectrum(bands);
}

function closeEpisode() {
  const ep = M.ep; M.ep = null;
  if (ep && ep.dur >= 1) {
    EVENTS.unshift({ start: ep.start, dur: ep.dur, max: ep.max });
    if (EVENTS.length > 30) EVENTS.pop();
    renderEvents();
  }
}

function computeBands(totalDb) {
  const sr = A.ctx.sampleRate, binHz = sr / A.sAn.fftSize;
  const pw = new Array(BANDS.length).fill(0);
  let total = 0;
  for (let i = 0; i < BANDS.length; i++) {
    const lo = Math.max(1, Math.ceil(BANDS[i] / Math.SQRT2 / binHz));
    const hi = Math.min(A.bs.length - 1, Math.floor(BANDS[i] * Math.SQRT2 / binHz));
    let p = 0;
    for (let b = lo; b <= hi; b++) { const d = A.bs[b]; if (isFinite(d)) p += Math.pow(10, d / 10); }
    pw[i] = p; total += p;
  }
  if (total <= 0) return null;
  const out = pw.map((p) => (p > 0 ? totalDb + 10 * Math.log10(p / total) : 0));
  for (let i = 0; i < out.length; i++) bandShown[i] = bandShown[i] ? bandShown[i] * 0.5 + out[i] * 0.5 : out[i];
  return bandShown;
}

/* ---------------- UI: live readout ---------------- */
function fmt(v) { return isFinite(v) ? v.toFixed(1) : '--'; }
function fmtTime(s) {
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}
function fmtAllow(sec) {
  if (sec >= 8 * 3600 * 2) return 'ไม่จำกัด (> 16 ชม.)';
  if (sec >= 3600) return `${(sec / 3600).toFixed(1)} ชั่วโมง`;
  if (sec >= 60) return `${Math.round(sec / 60)} นาที`;
  return `${Math.max(1, Math.round(sec))} วินาที`;
}
const unitText = () => (S.weighting === 'A' ? 'dB(A)' : 'dB(Z)');

function updateLive(L, now) {
  const hero = $('hero');
  const z = zoneOf(L);
  hero.dataset.zone = z.key;
  const alarm = !!(M.ep && M.ep.dur >= 3);
  hero.dataset.alarm = alarm ? '1' : '0';
  const alarmZone = alarm && (z.key === 'bad' || z.key === 'crit') ? ' · เกินต่อเนื่อง' : '';
  if ($('zone').textContent !== z.text + alarmZone) $('zone').textContent = z.text + alarmZone;

  const pct = clamp((L - METER_MIN) / (METER_MAX - METER_MIN), 0, 1) * 100;
  $('meterCover').style.transform = `scaleX(${(100 - pct) / 100})`;
  const hp = clamp((M.hold - METER_MIN) / (METER_MAX - METER_MIN), 0, 1) * 100;
  const h = $('meterHold'); h.style.left = `calc(${hp}% - 1.5px)`; h.style.opacity = M.hold > METER_MIN ? .9 : 0;

  $('clip').hidden = now > clipUntil;

  if (now - lastText > 200) {
    lastText = now;
    $('level').textContent = L.toFixed(0);
    document.title = alarm ? `⚠ ${L.toFixed(0)} dB — Factory Noise Meter` : `${L.toFixed(0)} ${unitText()} — Factory Noise Meter`;
    updateStatsUI(false);
  }
}

function updateStatsUI(reset) {
  $('unit').textContent = unitText();
  if (reset || M.T === 0) {
    for (const id of ['sLeq', 'sMax', 'sMin', 'sPeak', 'sAllow', 'sDose']) $(id).textContent = '--';
    $('sOver').textContent = '0:00'; $('sTime').textContent = '0:00';
    if (reset && !A.running) { $('level').textContent = '--'; $('hero').dataset.zone = 'idle'; $('hero').dataset.alarm = '0'; $('zone').textContent = 'รอเริ่มวัด'; $('meterCover').style.transform = 'scaleX(1)'; $('meterHold').style.opacity = 0; document.title = 'Factory Noise Meter'; }
    return;
  }
  const leq = toDb(M.E / M.T);
  $('sLeq').textContent = fmt(leq);
  $('sMax').textContent = fmt(M.lmax);
  $('sMin').textContent = fmt(M.lmin);
  $('sPeak').textContent = fmt(M.peak);
  $('sOver').textContent = fmtTime(M.overT);
  $('sTime').textContent = fmtTime(M.T);
  $('sAllow').textContent = M.L != null ? fmtAllow(allowedSeconds(M.L)) : '--';
  if (M.T >= 5 && M.dose > 0) {
    const proj = (M.dose / M.T) * 28800 * 100;
    const { crit, q } = doseCfg();
    const twa = crit + q * Math.log2(proj / 100);
    $('sDose').textContent = `${proj.toFixed(0)}% · ${twa.toFixed(1)} dB`;
  } else {
    $('sDose').textContent = M.T >= 5 ? '0% · < ' + DOSE_FLOOR_DB + ' dB' : 'กำลังเก็บข้อมูล…';
  }
}

function renderEvents() {
  const ol = $('evList'); ol.replaceChildren();
  $('evEmpty').hidden = EVENTS.length > 0;
  for (const e of EVENTS) {
    const li = document.createElement('li');
    const when = document.createElement('span'); when.className = 'when';
    when.textContent = `${e.start.toLocaleTimeString('th-TH')} · นาน ${fmtTime(e.dur)}`;
    const pk = document.createElement('span'); pk.className = 'peak';
    pk.textContent = `สูงสุด ${e.max.toFixed(1)} dB`;
    li.append(when, pk); ol.append(li);
  }
}

/* ---------------- charts ---------------- */
const css = getComputedStyle(document.documentElement);
const COL = {
  ok: css.getPropertyValue('--ok').trim(), warn: css.getPropertyValue('--warn').trim(),
  bad: css.getPropertyValue('--bad').trim(), crit: css.getPropertyValue('--crit').trim(),
  mute: css.getPropertyValue('--mute').trim(), line: css.getPropertyValue('--line').trim(),
  text: css.getPropertyValue('--text').trim(), accent: css.getPropertyValue('--accent').trim(),
};

function fitCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(10, Math.round(cv.clientWidth * dpr)), h = Math.max(10, Math.round(cv.clientHeight * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, W: cv.clientWidth, H: cv.clientHeight };
}

function drawHistory() {
  const { g, W, H } = fitCanvas($('hist'));
  g.clearRect(0, 0, W, H);
  const padL = 36, padR = 10, padT = 10, padB = 22;
  const pw = W - padL - padR, ph = H - padT - padB;
  const Y0 = 30, Y1 = 120;
  const yOf = (v) => padT + ph * (1 - (clamp(v, Y0, Y1) - Y0) / (Y1 - Y0));

  // แถบโซน
  const zones = [[Y0, S.warn, null], [S.warn, S.limit, COL.warn], [S.limit, S.danger, COL.bad], [S.danger, Y1, COL.crit]];
  g.globalAlpha = 0.10;
  for (const [a, b, c] of zones) {
    if (!c) continue;
    g.fillStyle = c; g.fillRect(padL, yOf(b), pw, yOf(a) - yOf(b));
  }
  g.globalAlpha = 1;

  // เส้นกริด + ป้ายแกน Y
  g.font = '11px "Cascadia Mono", Consolas, monospace';
  g.textBaseline = 'middle'; g.textAlign = 'right';
  for (let v = 30; v <= 120; v += 15) {
    const y = yOf(v);
    g.strokeStyle = COL.line; g.lineWidth = 1;
    g.beginPath(); g.moveTo(padL, y + .5); g.lineTo(W - padR, y + .5); g.stroke();
    g.fillStyle = COL.mute; g.fillText(String(v), padL - 6, y);
  }
  // เส้นเกณฑ์
  g.setLineDash([5, 4]); g.lineWidth = 1;
  for (const [v, c] of [[S.warn, COL.warn], [S.limit, COL.bad], [S.danger, COL.crit]]) {
    g.strokeStyle = c; g.globalAlpha = .7;
    g.beginPath(); g.moveTo(padL, yOf(v) + .5); g.lineTo(W - padR, yOf(v) + .5); g.stroke();
  }
  g.setLineDash([]); g.globalAlpha = 1;

  // แกน X
  g.textBaseline = 'top'; g.textAlign = 'center'; g.fillStyle = COL.mute;
  g.fillText('-2:00', padL + 14, H - padB + 6);
  g.fillText('-1:00', padL + pw / 2, H - padB + 6);
  g.fillText('ตอนนี้', W - padR - 16, H - padB + 6);

  if (HIST.length < 2) return;
  const now = performance.now();
  const xOf = (t) => padL + pw * (1 - (now - t) / (HIST_SECONDS * 1000));

  // เส้นระดับเสียง ไล่สีตามโซน
  const grad = g.createLinearGradient(0, yOf(Y1), 0, yOf(Y0));
  const stop = (v) => clamp(1 - (v - Y0) / (Y1 - Y0), 0, 1);
  const st = [[stop(S.danger), COL.crit], [stop(S.danger), COL.bad], [stop(S.limit), COL.bad], [stop(S.limit), COL.warn],
              [stop(S.warn), COL.warn], [stop(S.warn), COL.ok], [1, COL.ok]];
  let prev = 0;
  for (const [o, c] of st) { prev = Math.max(prev, o); grad.addColorStop(prev, c); }
  g.strokeStyle = grad; g.lineWidth = 2; g.lineJoin = 'round';
  g.beginPath();
  HIST.forEach((p, i) => { const x = xOf(p.t), y = yOf(p.L); i ? g.lineTo(x, y) : g.moveTo(x, y); });
  g.stroke();
}

function drawSpectrum(bands) {
  const { g, W, H } = fitCanvas($('spec'));
  g.clearRect(0, 0, W, H);
  const padL = 36, padR = 10, padT = 10, padB = 24;
  const pw = W - padL - padR, ph = H - padT - padB;
  const Y0 = 20, Y1 = 110;
  const yOf = (v) => padT + ph * (1 - (clamp(v, Y0, Y1) - Y0) / (Y1 - Y0));

  g.font = '11px "Cascadia Mono", Consolas, monospace';
  g.textAlign = 'right'; g.textBaseline = 'middle';
  for (let v = 20; v <= 110; v += 30) {
    const y = yOf(v);
    g.strokeStyle = COL.line; g.lineWidth = 1;
    g.beginPath(); g.moveTo(padL, y + .5); g.lineTo(W - padR, y + .5); g.stroke();
    g.fillStyle = COL.mute; g.fillText(String(v), padL - 6, y);
  }

  const slot = pw / BANDS.length, bw = Math.min(46, slot * 0.62);
  let maxI = -1;
  if (bands) { let m = -Infinity; bands.forEach((v, i) => { if (v > m) { m = v; maxI = i; } }); }

  g.textAlign = 'center'; g.textBaseline = 'top';
  BANDS.forEach((_, i) => {
    const cx = padL + slot * (i + .5);
    g.fillStyle = i === maxI ? COL.text : COL.mute;
    g.fillText(BAND_LABEL[i], cx, H - padB + 6);
    if (!bands || !bands[i]) return;
    const y = yOf(bands[i]);
    g.fillStyle = i === maxI ? COL.accent : '#2d7f98';
    g.fillRect(cx - bw / 2, y, bw, padT + ph - y);
  });
  g.fillStyle = COL.mute; g.textAlign = 'left'; g.fillText('Hz', padL - 30, H - padB + 6);

  $('dominant').textContent = bands && maxI >= 0 ? `ย่านเด่น: ${BAND_LABEL[maxI]} Hz (${bands[maxI].toFixed(0)} dB)` : 'ย่านเด่น: --';
}

function buildMeterBackground() {
  const pct = (v) => clamp((v - METER_MIN) / (METER_MAX - METER_MIN), 0, 1) * 100;
  const a = pct(S.warn), b = pct(S.limit), c = pct(S.danger);
  $('meter').style.background =
    `linear-gradient(90deg, ${COL.ok} 0 ${a}%, ${COL.warn} ${a}% ${b}%, ${COL.bad} ${b}% ${c}%, ${COL.crit} ${c}% 100%)`;
  const t = $('ticks'); t.replaceChildren();
  for (let v = METER_MIN; v <= METER_MAX; v += 10) {
    const s = document.createElement('span');
    s.textContent = v; s.style.left = pct(v) + '%'; t.append(s);
  }
}

/* ---------------- point measurement ---------------- */
function startPoint() {
  if (!A.running) { showNotice('ต้องเริ่มวัด (ไมโครโฟนหรือโหมดจำลอง) ก่อนจึงจะบันทึกจุดวัดได้'); return; }
  hideNotice();
  const dur = Number($('fDur').value) || 30;
  P = { dur, T: 0, E: 0, max: -Infinity, min: Infinity, peak: -Infinity, levels: [],
        machine: $('fMachine').value.trim() || 'ไม่ระบุเครื่อง', state: $('fState').value.trim(), point: $('fPoint').value.trim(),
        weighting: S.weighting, speed: S.speed, cal: S.cal };
  $('btnRec').textContent = 'ยกเลิกการบันทึก';
  $('progress').hidden = false; $('progressBar').style.transform = 'scaleX(0)';
  $('recText').textContent = `กำลังบันทึก 0/${dur} วินาที…`;
}
function cancelPoint(msg) {
  P = null;
  $('btnRec').textContent = 'เริ่มบันทึกจุดวัด';
  $('progress').hidden = true;
  $('recText').textContent = msg || '';
}
function stepPoint(dt, msInst, L, Lpk) {
  P.T += dt; P.E += msInst * dt;
  P.levels.push(L); P.max = Math.max(P.max, L); P.min = Math.min(P.min, L); P.peak = Math.max(P.peak, Lpk);
  $('progressBar').style.transform = `scaleX(${Math.min(1, P.T / P.dur)})`;
  $('recText').textContent = `กำลังบันทึก ${Math.min(P.dur, Math.floor(P.T))}/${P.dur} วินาที…`;
  if (P.T >= P.dur) finishPoint();
}
function percentile(sorted, p) {
  const i = clamp(Math.round((sorted.length - 1) * p), 0, sorted.length - 1);
  return sorted[i];
}
function finishPoint() {
  const sorted = P.levels.slice().sort((a, b) => a - b);
  const leq = toDb(P.E / P.T);
  const rec = {
    id: Date.now(), time: new Date().toISOString(),
    machine: P.machine, state: P.state, point: P.point, dur: Math.round(P.T),
    leq, lmax: P.max, lmin: P.min, l10: percentile(sorted, 0.9), l90: percentile(sorted, 0.1), lpeak: P.peak,
    weighting: P.weighting, speed: P.speed, cal: P.cal, limit: S.limit, danger: S.danger,
  };
  LOG.unshift(rec); saveLog(); renderLog();
  cancelPoint(`บันทึกแล้ว: ${rec.machine} Leq ${rec.leq.toFixed(1)} dB`);
}

function resultOf(r) {
  if (r.leq >= r.danger) return { cls: 'crit', text: 'อันตราย' };
  if (r.leq >= r.limit) return { cls: 'bad', text: 'เกินเกณฑ์' };
  if (r.leq >= (S.warn)) return { cls: 'warn', text: 'เฝ้าระวัง' };
  return { cls: 'ok', text: 'ปกติ' };
}

function renderLog() {
  const body = $('logBody'); body.replaceChildren();
  $('logEmpty').hidden = LOG.length > 0;
  $('logTable').style.display = LOG.length ? '' : 'none';
  for (const r of LOG) {
    const tr = document.createElement('tr');
    const cell = (txt, cls) => { const td = document.createElement('td'); td.textContent = txt; if (cls) td.className = cls; return td; };
    const d = new Date(r.time);
    tr.append(
      cell(d.toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'medium' })),
      cell(r.machine, 'wrap'), cell(r.state || '-', 'wrap'), cell(r.point || '-', 'wrap'),
      cell(r.leq.toFixed(1), 'n'), cell(r.lmax.toFixed(1), 'n'), cell(r.l10.toFixed(1), 'n'), cell(r.l90.toFixed(1), 'n'),
    );
    const res = resultOf(r);
    const tdRes = document.createElement('td');
    const chip = document.createElement('span'); chip.className = 'chip ' + res.cls; chip.textContent = res.text;
    tdRes.append(chip); tr.append(tdRes);
    const tdDel = document.createElement('td');
    const del = document.createElement('button'); del.className = 'del'; del.type = 'button'; del.textContent = '×';
    del.setAttribute('aria-label', 'ลบรายการนี้');
    del.addEventListener('click', () => { LOG = LOG.filter((x) => x.id !== r.id); saveLog(); renderLog(); });
    tdDel.append(del); tr.append(tdDel);
    body.append(tr);
  }
}

function exportCsv() {
  if (!LOG.length) { showNotice('ยังไม่มีผลวัดให้ส่งออก'); return; }
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const head = ['เวลา', 'เครื่องจักร', 'สถานะ', 'จุดวัด', 'ระยะเวลา(วินาที)', 'Leq', 'Lmax', 'Lmin', 'L10', 'L90', 'Lpeak', 'ถ่วงน้ำหนักความถี่', 'ถ่วงน้ำหนักเวลา', 'Offset', 'ผล'];
  const rows = LOG.slice().reverse().map((r) => [
    new Date(r.time).toLocaleString('sv-SE'), r.machine, r.state, r.point, r.dur,
    r.leq.toFixed(1), r.lmax.toFixed(1), r.lmin.toFixed(1), r.l10.toFixed(1), r.l90.toFixed(1), r.lpeak.toFixed(1),
    r.weighting, r.speed, r.cal, resultOf(r).text,
  ]);
  const csv = '﻿' + [head, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = `noise-log-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------------- start / stop ---------------- */
function showNotice(msg, retry) {
  const n = $('notice');
  n.replaceChildren();
  const t = document.createElement('span'); t.textContent = msg; n.append(t);
  if (retry) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn'; b.textContent = 'ลองอีกครั้ง';
    b.addEventListener('click', retry);
    n.append(b);
  }
  n.hidden = false;
}
function hideNotice() { $('notice').hidden = true; }

function setRunning(on, mode) {
  A.running = on; A.mode = on ? mode : null;
  $('btnMic').hidden = on; $('btnDemo').hidden = on; $('btnStop').hidden = !on;
  $('demoWrap').hidden = !(on && mode === 'demo');
  const st = $('status');
  st.className = 'status' + (on ? ' live' : '');
  st.textContent = on ? (mode === 'demo' ? 'กำลังวัด (โหมดจำลอง)' : 'กำลังวัดจากไมโครโฟน') : 'หยุดวัดแล้ว';
}

async function beginMeasuring(mode) {
  A.last = performance.now();
  if (!M || M.T > 0) resetStats();
  setRunning(true, mode);
  clearInterval(A.timer);
  A.timer = setInterval(tick, TICK_MS);
  if (S.wake && 'wakeLock' in navigator) {
    try { A.wake = await navigator.wakeLock.request('screen'); } catch { /* ไม่รองรับ/ถูกปฏิเสธ */ }
  }
}

async function startMic() {
  hideNotice();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showNotice('เบราว์เซอร์ไม่อนุญาตให้ใช้ไมโครโฟนบนหน้านี้ — ต้องเปิดผ่าน http://localhost หรือ https:// (http ธรรมดาจากเครื่องอื่นจะถูกบล็อก)');
    return;
  }
  stopAll(false);
  ensureGraph();
  try { await A.ctx.resume(); } catch { /* ignore */ }

  // ปิด AGC / noise suppression / echo cancel เพื่อให้วัดเสียงจริง
  const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
  if (S.deviceId) audio.deviceId = { exact: S.deviceId };
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio });
  } catch (e) {
    if (e && e.name === 'OverconstrainedError' && S.deviceId) {
      S.deviceId = ''; saveSettings();
      return startMic();
    }
    const map = {
      NotAllowedError: 'ยังไม่ได้อนุญาตให้ใช้ไมโครโฟน — ถ้ากด “บล็อก” หรือปิดหน้าต่างขอสิทธิ์ไปโดยไม่ตั้งใจ ไม่เป็นไร กดใหม่ได้: คลิกไอคอนกุญแจ/ตั้งค่าที่ซ้ายของแถบที่อยู่ → ไมโครโฟน → “อนุญาต” แล้วกด “ลองอีกครั้ง”',
      NotFoundError: 'ไม่พบไมโครโฟนในเครื่องนี้ — เสียบไมค์แล้วกด “ลองอีกครั้ง”',
      NotReadableError: 'ไมโครโฟนถูกโปรแกรมอื่นใช้อยู่ หรือเปิดไม่ได้ — ปิดโปรแกรมนั้นแล้วกด “ลองอีกครั้ง”',
    };
    showNotice(map[e && e.name] || `เปิดไมโครโฟนไม่สำเร็จ: ${e && e.message}`, startMic);
    return;
  }
  A.stream = stream;
  A.src = A.ctx.createMediaStreamSource(stream);
  A.src.connect(A.input);
  populateDevices();
  stream.getAudioTracks()[0].addEventListener('ended', () => { if (A.mode === 'mic') { stopAll(true); showNotice('ไมโครโฟนถูกตัดการเชื่อมต่อ'); } });
  await beginMeasuring('mic');
}

/* โหมดจำลอง: เสียงมอเตอร์ 100 Hz + เสียงลม/เสียดสี + แรงกระแทกเป็นจังหวะ ไว้ลองใช้โดยไม่ต้องมีไมค์ */
async function startDemo() {
  hideNotice();
  stopAll(false);
  ensureGraph();
  try { await A.ctx.resume(); } catch { /* ignore */ }
  const ctx = A.ctx;

  const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = nb.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0;                       // pink-ish noise
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.0990460; b1 = 0.96300 * b1 + w * 0.2965164; b2 = 0.57000 * b2 + w * 1.0526913;
    d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25;
  }
  const noise = ctx.createBufferSource(); noise.buffer = nb; noise.loop = true;
  const nLp = ctx.createBiquadFilter(); nLp.type = 'lowpass'; nLp.frequency.value = 3000;
  const nGain = ctx.createGain(); nGain.gain.value = 0.35;

  const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 100;
  const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = 50;
  const oGain = ctx.createGain(); oGain.gain.value = 0.12;

  const imp = ctx.createBufferSource(); imp.buffer = nb; imp.loop = true;
  const iBp = ctx.createBiquadFilter(); iBp.type = 'bandpass'; iBp.frequency.value = 1800; iBp.Q.value = 0.8;
  const iGain = ctx.createGain(); iGain.gain.value = 0;

  const master = ctx.createGain();
  const apply = () => { master.gain.value = Math.pow(10, (Number($('demoLevel').value) - S.cal) / 20) * 4.5; };
  apply();

  noise.connect(nLp); nLp.connect(nGain); nGain.connect(master);
  o1.connect(oGain); o2.connect(oGain); oGain.connect(master);
  imp.connect(iBp); iBp.connect(iGain); iGain.connect(master);
  master.connect(A.input);
  [noise, o1, o2, imp].forEach((n) => n.start());

  const hit = () => {
    const t = ctx.currentTime;
    iGain.gain.cancelScheduledValues(t);
    iGain.gain.setValueAtTime(1.6, t);
    iGain.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
  };
  const hitTimer = setInterval(hit, 1600);
  A.demo = { nodes: [noise, o1, o2, imp], master, hitTimer, apply };
  await beginMeasuring('demo');
}

function stopAll(final) {
  clearInterval(A.timer); A.timer = null;
  if (A.stream) { A.stream.getTracks().forEach((t) => t.stop()); A.stream = null; }
  if (A.src) { try { A.src.disconnect(); } catch { /* */ } A.src = null; }
  if (A.demo) {
    clearInterval(A.demo.hitTimer);
    A.demo.nodes.forEach((n) => { try { n.stop(); n.disconnect(); } catch { /* */ } });
    try { A.demo.master.disconnect(); } catch { /* */ }
    A.demo = null;
  }
  if (A.wake) { try { A.wake.release(); } catch { /* */ } A.wake = null; }
  if (P) cancelPoint('หยุดวัดก่อนครบเวลา — ไม่ได้บันทึก');
  if (M && M.ep) closeEpisode();
  if (final) setRunning(false);
}

async function populateDevices() {
  try {
    const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    const sel = $('selDevice'); sel.replaceChildren(new Option('ค่าเริ่มต้นของเครื่อง', ''));
    list.forEach((d, i) => sel.append(new Option(d.label || `ไมโครโฟน ${i + 1}`, d.deviceId)));
    sel.value = S.deviceId;
  } catch { /* ignore */ }
}

/* ---------------- settings UI ---------------- */
function bindSettings() {
  document.querySelectorAll('[data-set]').forEach((el) => {
    const key = el.dataset.set;
    el.value = S[key];
    el.addEventListener('change', () => {
      const num = el.type === 'number';
      let v = num ? Number(el.value) : el.value;
      if (num && !isFinite(v)) { el.value = S[key]; return; }
      S[key] = v;
      // ให้เกณฑ์เรียงลำดับ warn ≤ limit ≤ danger
      if (['warn', 'limit', 'danger'].includes(key)) {
        S.limit = Math.max(S.limit, S.warn); S.danger = Math.max(S.danger, S.limit);
        document.querySelectorAll('[data-set="limit"],[data-set="danger"]').forEach((e) => { e.value = S[e.dataset.set]; });
      }
      saveSettings(); buildMeterBackground();
      if (key === 'deviceId' && A.mode === 'mic') startMic();
      if (key === 'cal' && A.demo) A.demo.apply();
      if (M && M.T === 0) updateStatsUI(true); else updateStatsUI(false);
      drawHistory();
    });
  });

  for (const [id, key] of [['fMachine', 'machine'], ['fState', 'state'], ['fPoint', 'point'], ['fDur', 'dur']]) {
    const el = $(id); el.value = S[key];
    el.addEventListener('input', () => { S[key] = el.value; saveSettings(); });
  }
  $('chkWake').checked = S.wake;
  $('chkWake').addEventListener('change', (e) => { S.wake = e.target.checked; saveSettings(); });

  $('demoLevel').addEventListener('input', (e) => { $('demoOut').textContent = e.target.value; if (A.demo) A.demo.apply(); });

  $('btnCal').addEventListener('click', () => {
    const ref = Number($('calRef').value);
    if (!A.running || !M || M.rawDb == null) { $('calText').textContent = 'ต้องเริ่มวัดและวางไมค์ข้างเครื่องอ้างอิงก่อน'; return; }
    if (!isFinite(ref) || ref <= 0) { $('calText').textContent = 'กรอกค่าอ้างอิงเป็นตัวเลข เช่น 94'; return; }
    S.cal = Math.round((ref - M.rawDb) * 10) / 10;
    saveSettings();
    document.querySelector('[data-set="cal"]').value = S.cal;
    $('calText').textContent = `ตั้ง Offset = ${S.cal} dB แล้ว (บันทึกไว้ในเบราว์เซอร์นี้)`;
    resetStats();
  });
}

/* ---------------- wiring ---------------- */
$('btnMic').addEventListener('click', startMic);
$('btnDemo').addEventListener('click', startDemo);
$('btnStop').addEventListener('click', () => stopAll(true));
$('btnReset').addEventListener('click', () => { if (P) cancelPoint(); resetStats(); });
$('btnRec').addEventListener('click', () => (P ? cancelPoint('ยกเลิกแล้ว') : startPoint()));
$('btnCsv').addEventListener('click', exportCsv);
$('btnClearLog').addEventListener('click', () => {
  if (LOG.length && confirm(`ลบผลวัดทั้งหมด ${LOG.length} รายการ? (กู้คืนไม่ได้ — ส่งออก CSV ไว้ก่อนได้)`)) { LOG = []; saveLog(); renderLog(); }
});
window.addEventListener('resize', () => { drawHistory(); drawSpectrum(A.running ? bandShown : null); });
document.addEventListener('visibilitychange', async () => {
  // wake lock หลุดเมื่อสลับแท็บ — ขอใหม่เมื่อกลับมา
  if (document.visibilityState === 'visible' && A.running && S.wake && 'wakeLock' in navigator && !A.wake) {
    try { A.wake = await navigator.wakeLock.request('screen'); } catch { /* */ }
  }
});

buildMeterBackground();
bindSettings();
renderLog();
resetStats();
$('demoOut').textContent = $('demoLevel').value;

// ตัวช่วยทดสอบ (เรียกจาก console)
window.__noiseMeter = { aWeightResponse: (hz) => {
  if (!A.ctx) ensureGraph();
  const f = new Float32Array([hz]), m = new Float32Array(1), p = new Float32Array(1);
  let g = A.aTrim.gain.value;
  for (const s of A.aSecs) { s.getFrequencyResponse(f, m, p); g *= m[0]; }
  return 20 * Math.log10(g);
} };
