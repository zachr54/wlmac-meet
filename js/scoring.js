// Powerlifting rules and maths: totals, DOTS, IPF GL points, lifting order, plate loading.
// No DOM access, so it also runs under Node for tests.
(function (root) {
  const PL = root.PL = root.PL || {};

  PL.LIFTS = { squat: 'Squat', bench: 'Bench', deadlift: 'Deadlift' };
  PL.LIFT_SHORT = { squat: 'S', bench: 'B', deadlift: 'D' };
  PL.FORMATS = {
    sbd: { label: 'Full power (squat, bench, deadlift)', lifts: ['squat', 'bench', 'deadlift'] },
    bench: { label: 'Bench only', lifts: ['bench'] },
    pp: { label: 'Push-pull (bench, deadlift)', lifts: ['bench', 'deadlift'] },
  };
  PL.DEFAULT_SETTINGS = { format: 'sbd', lifts: ['squat', 'bench', 'deadlift'], barKg: 20, collarKg: 2.5, clockSeconds: 60, equipped: false };

  PL.emptyAttempts = () => {
    const row = () => [0, 1, 2].map(() => ({ w: null, r: null }));
    return { squat: row(), bench: row(), deadlift: row() };
  };
  PL.attempt = (lifter, lift, idx) => (lifter.attempts && lifter.attempts[lift] && lifter.attempts[lift][idx]) || { w: null, r: null };

  PL.newState = settings => ({
    lift: settings.lifts[0], attempt: 1, flight: 'A', lifterId: null,
    lights: {}, revealed: false, result: null,
    timer: { running: false, endsAt: 0, remainingMs: settings.clockSeconds * 1000 },
  });
  PL.clearedPlatform = settings => ({
    lights: {}, revealed: false, result: null,
    timer: { running: false, endsAt: 0, remainingMs: settings.clockSeconds * 1000 },
  });

  PL.fmt = w => (w === null || w === undefined || w === '' || isNaN(w)) ? '' : String(+(+w).toFixed(2));
  PL.fmtScore = s => s ? s.toFixed(2) : '—';

  // ---------- totals ----------
  PL.best = (lifter, lift) => {
    let best = 0;
    for (let i = 0; i < 3; i++) { const a = PL.attempt(lifter, lift, i); if (a.r === 'good' && +a.w > best) best = +a.w; }
    return best;
  };
  // Three failed attempts on one lift = bombed out, no total.
  PL.bombed = (lifter, lifts) => lifts.some(lift => [0, 1, 2].every(i => PL.attempt(lifter, lift, i).r === 'no'));
  PL.total = (lifter, lifts) => PL.bombed(lifter, lifts) ? 0 : lifts.reduce((sum, lift) => sum + PL.best(lifter, lift), 0);

  // ---------- points ----------
  const DOTS = {
    M: [-307.75076, 24.0900756, -0.1918759221, 0.0007391293, -0.000001093],
    F: [-57.96288, 13.6175032, -0.1126655495, 0.0005158568, -0.0000010706],
  };
  PL.dots = (sex, bw, total) => {
    if (!(bw > 0) || !(total > 0)) return 0;
    const c = DOTS[sex === 'F' ? 'F' : 'M'];
    const x = Math.min(Math.max(bw, 40), sex === 'F' ? 150 : 210);
    return total * 500 / (c[0] + c[1] * x + c[2] * x ** 2 + c[3] * x ** 3 + c[4] * x ** 4);
  };

  // IPF GL (Goodlift) points, 2020 coefficients: total * 100 / (A - B * e^(-C * bw)).
  const GL = {
    M: { raw: { sbd: [1199.72839, 1025.18162, 0.00921], bench: [320.98041, 281.40258, 0.01008] },
         eq: { sbd: [1236.25115, 1449.21864, 0.01644], bench: [381.22073, 733.79378, 0.02398] } },
    F: { raw: { sbd: [610.32796, 1045.59282, 0.03048], bench: [142.40398, 442.52671, 0.04724] },
         eq: { sbd: [758.63878, 949.31382, 0.02435], bench: [221.82209, 357.00377, 0.02937] } },
  };
  // GL is only defined for full power and bench-only; other formats return 0.
  PL.ipfGl = (sex, bw, total, settings) => {
    const format = settings && settings.format;
    if (!(bw > 0) || !(total > 0) || (format !== 'sbd' && format !== 'bench')) return 0;
    const c = GL[sex === 'F' ? 'F' : 'M'][settings.equipped ? 'eq' : 'raw'][format];
    return total * 100 / (c[0] - c[1] * Math.exp(-c[2] * bw));
  };

  const CLASSES = { M: [53, 59, 66, 74, 83, 93, 105, 120], F: [43, 47, 52, 57, 63, 69, 76, 84] };
  PL.weightClass = (sex, bw) => {
    if (!(bw > 0)) return '';
    const list = CLASSES[sex === 'F' ? 'F' : 'M'];
    const cls = list.find(c => bw <= c);
    return cls ? String(cls) : list[list.length - 1] + '+';
  };
  const classSort = cls => cls ? parseFloat(cls) + (cls.endsWith('+') ? 0.5 : 0) : 9999;

  // ---------- lifting order ----------
  const byBar = (lift, idx) => (a, b) =>
    (+PL.attempt(a, lift, idx).w - +PL.attempt(b, lift, idx).w) || ((a.lot || 9999) - (b.lot || 9999)) || a.name.localeCompare(b.name);
  // Lifters still to go this round, lightest bar first, lot number breaking ties.
  PL.pending = (lifters, lift, idx) =>
    lifters.filter(l => { const a = PL.attempt(l, lift, idx); return +a.w > 0 && !a.r; }).sort(byBar(lift, idx));
  // Whole round in bar order; lifters with no weight declared go last.
  PL.roundOrder = (lifters, lift, idx) => {
    const declared = lifters.filter(l => +PL.attempt(l, lift, idx).w > 0).sort(byBar(lift, idx));
    const rest = lifters.filter(l => !(+PL.attempt(l, lift, idx).w > 0)).sort((a, b) => ((a.lot || 9999) - (b.lot || 9999)) || a.name.localeCompare(b.name));
    return declared.concat(rest);
  };
  PL.flights = lifters => {
    const set = Array.from(new Set(lifters.map(l => l.flight || 'A'))).sort();
    return set.length ? set : ['A'];
  };

  // Where the platform goes next: first pending lifter this round, else roll to the next round.
  PL.nextUp = (lifters, state) => {
    const flight = lifters.filter(l => (l.flight || 'A') === state.flight);
    let attempt = state.attempt;
    let next = PL.pending(flight, state.lift, attempt - 1)[0];
    const roundStarted = flight.some(l => PL.attempt(l, state.lift, attempt - 1).r);
    if (!next && attempt < 3 && roundStarted) { attempt += 1; next = PL.pending(flight, state.lift, attempt - 1)[0]; }
    return { attempt, lifterId: next ? next.id : null };
  };

  // ---------- rankings ----------
  PL.scoreRows = (lifters, settings) => {
    const rows = lifters.map(l => {
      const bw = +l.bodyweight || 0;
      const total = PL.total(l, settings.lifts);
      return {
        lifter: l, bw, total, bombed: PL.bombed(l, settings.lifts),
        cls: PL.weightClass(l.sex, bw),
        dots: PL.dots(l.sex, bw, total), gl: PL.ipfGl(l.sex, bw, total, settings), place: null,
      };
    });
    const groups = {};
    rows.forEach(r => { (groups[r.lifter.sex + '|' + r.cls] = groups[r.lifter.sex + '|' + r.cls] || []).push(r); });
    Object.values(groups).forEach(g => {
      // Higher total wins; on a tie the lighter lifter places higher.
      g.filter(r => r.total > 0).sort((a, b) => (b.total - a.total) || (a.bw - b.bw)).forEach((r, i) => { r.place = i + 1; });
    });
    return rows;
  };
  PL.sortRows = (rows, mode) => {
    const out = rows.slice();
    if (mode === 'dots' || mode === 'gl') return out.sort((a, b) => (b[mode] - a[mode]) || (b.total - a.total));
    return out.sort((a, b) =>
      (a.lifter.sex === b.lifter.sex ? 0 : a.lifter.sex === 'F' ? -1 : 1) ||
      (classSort(a.cls) - classSort(b.cls)) || ((a.place || 999) - (b.place || 999)) || a.lifter.name.localeCompare(b.lifter.name));
  };

  // ---------- plate loading ----------
  PL.PLATES = [25, 20, 15, 10, 5, 2.5, 1.25, 0.5, 0.25];
  // Plates for ONE side of the bar. `short` is what can't be made with the plate set.
  PL.plates = (weight, barKg, collarKg) => {
    let side = Math.round(((+weight - barKg - 2 * collarKg) / 2) * 1000) / 1000;
    const out = [];
    if (!(side > 0)) return { plates: out, short: side < 0 ? side * 2 : 0 };
    for (const p of PL.PLATES) while (side >= p - 1e-9) { out.push(p); side = Math.round((side - p) * 1000) / 1000; }
    return { plates: out, short: side * 2 };
  };

  // ---------- referee decisions ----------
  PL.POSITIONS = ['left', 'head', 'right'];
  PL.verdict = lights => PL.POSITIONS.filter(p => lights[p] === 'white').length >= 2 ? 'good' : 'no';
})(typeof window !== 'undefined' ? window : globalThis);
