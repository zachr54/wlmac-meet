// Big-screen display. One page, three views: lights, scoreboard, results.
(function () {
  const { esc } = PL;
  const root = document.getElementById('app');
  const code = (PL.param('meet') || '').toUpperCase();
  const VIEWS = ['lights', 'board', 'results'];
  const MODES = Object.keys(PL.RESULT_MODES);
  let view = VIEWS.includes(PL.param('view')) ? PL.param('view') : 'lights';
  let mode = 'class', data = null, loaded = false;

  const flightOf = l => l.flight || 'A';

  function header(m, right) {
    return `<header class="d-top">
      <img src="assets/wlmac-crest-t.png" alt="">
      <div class="d-title"><span class="eyebrow">WLMAC Fitness Club</span><b>${esc(m.name)}</b></div>
      <div class="d-ctx">${right}</div>
    </header>`;
  }
  const context = st => `<span class="live"><i></i>Live</span>${PL.LIFTS[st.lift]} · Attempt ${st.attempt} · Flight ${esc(st.flight)}`;
  const meta = (l, st) => [
    PL.weightClass(l.sex, +l.bodyweight) && PL.weightClass(l.sex, +l.bodyweight) + ' kg class',
    l.bodyweight && 'BW ' + PL.fmt(l.bodyweight) + ' kg', l.team,
    st.lift === 'squat' && l.rack_squat && 'Rack ' + l.rack_squat, st.lift === 'bench' && l.rack_bench && 'Rack ' + l.rack_bench,
  ].filter(Boolean).map(esc).join('<i>·</i>');

  function viewLights(m, lifters) {
    const st = m.state, idx = st.attempt - 1;
    const cur = lifters.find(l => l.id === st.lifterId);
    const flight = lifters.filter(l => flightOf(l) === st.flight);
    const next = PL.pending(flight, st.lift, idx).filter(l => !cur || l.id !== cur.id).slice(0, 3);
    const a = cur ? PL.attempt(cur, st.lift, idx) : null;
    const stage = cur ? `
      <div class="s-info">
        <span class="eyebrow red">On the platform</span>
        <div class="s-name">${esc(cur.name)}</div>
        <div class="s-meta">${meta(cur, st)}</div>
        ${PL.platesHtml(a.w, m.settings)}
        <div class="s-weight">${PL.fmt(a.w) || '—'}<small>kg</small></div>
      </div>
      <div class="s-side">
        ${PL.lightsHtml(st, 'big')}
        ${st.revealed
          ? `<div class="s-verdict ${st.result}">${st.result === 'good' ? 'Good lift' : 'No lift'}</div>`
          : `<div class="s-clock" data-timer>${PL.clockText(PL.timerMs(st.timer))}</div>`}
      </div>` : `
      <div class="s-wait"><img src="assets/wlmac-crest-t.png" alt=""><div class="s-name">${PL.LIFTS[st.lift]}</div><div class="s-meta">Flight ${esc(st.flight)} · waiting for the next lifter</div></div>`;
    return header(m, context(st)) + `<main class="stage">${stage}</main>
      <footer class="nextup"><span class="eyebrow">Next up</span>${next.map(l => `<span class="nx"><b>${esc(l.name)}</b>${PL.fmt(PL.attempt(l, st.lift, idx).w)} kg</span>`).join('') || '<span class="nx muted">—</span>'}</footer>`;
  }

  function viewBoard(m, lifters) {
    const st = m.state, set = m.settings, idx = st.attempt - 1;
    const cur = lifters.find(l => l.id === st.lifterId);
    const scores = {};
    PL.scoreRows(lifters, set).forEach(r => { scores[r.lifter.id] = r; });
    const rows = PL.roundOrder(lifters.filter(l => flightOf(l) === st.flight), st.lift, idx);
    const body = rows.map(l => {
      const r = scores[l.id], isCur = cur && l.id === cur.id;
      return `<tr class="${isCur ? 'cur-row' : ''}">
        <td class="name">${esc(l.name)}</td><td class="num">${r.cls || ''}</td><td class="num">${r.bw ? PL.fmt(r.bw) : ''}</td>
        ${set.lifts.map(lift => [0, 1, 2].map(i => PL.attemptCell(l, lift, i, isCur && lift === st.lift && i === idx)).join('')).join('')}
        <td class="num total">${r.total ? PL.fmt(r.total) : '—'}</td><td class="num">${PL.fmtScore(r.dots)}</td><td class="num">${PL.fmtScore(r.gl)}</td>
        <td class="num rank">${r.place || (r.bombed ? 'DQ' : '')}</td></tr>`;
    }).join('');
    const now = cur ? `<div class="b-now">
        <div><span class="eyebrow red">On the platform</span><div class="b-name">${esc(cur.name)}</div></div>
        <div class="b-weight">${PL.fmt(PL.attempt(cur, st.lift, idx).w)}<small>kg</small></div>
        ${PL.lightsHtml(st, 'mid')}
        ${st.revealed ? `<div class="b-verdict ${st.result}">${st.result === 'good' ? 'Good lift' : 'No lift'}</div>` : `<div class="b-clock" data-timer>${PL.clockText(PL.timerMs(st.timer))}</div>`}
      </div>` : '';
    return header(m, context(st)) + now + `<main class="board" style="--rows:${Math.max(rows.length, 6)}">
      <table class="tbl big">
        <thead><tr><th>Lifter</th><th class="num">Class</th><th class="num">BW</th>${set.lifts.map(l => '<th colspan="3" class="lift-h">' + PL.LIFTS[l] + '</th>').join('')}<th class="num">Total</th><th class="num">DOTS</th><th class="num">GL</th><th class="num">Pl</th></tr></thead>
        <tbody>${body || '<tr><td colspan="' + (7 + set.lifts.length * 3) + '" class="empty">No lifters in this flight yet.</td></tr>'}</tbody>
      </table></main>`;
  }

  function viewResults(m, lifters) {
    const tabs = MODES.map(k => `<button class="${mode === k ? 'on' : ''}" data-mode="${k}">${PL.RESULT_MODES[k]}</button>`).join('');
    return header(m, `<div class="seg">${tabs}</div>`) + `<main class="board" style="--rows:${Math.max(lifters.length + 2, 8)}">${PL.resultsHtml(lifters, m.settings, mode).replace('class="tbl results"', 'class="tbl big results"')}</main>`;
  }

  function draw() {
    if (!code) return PL.render(root, '<div class="d-msg"><b>No meet code</b><span>Open this screen from the director’s “Screens &amp; refs” tab.</span></div>');
    if (!loaded) return PL.render(root, '<div class="d-msg"><img src="assets/wlmac-crest-t.png" alt=""><span>Loading…</span></div>');
    if (!data) return PL.render(root, `<div class="d-msg"><b>Meet ${esc(code)} not found</b><span>Check the code with the meet director.</span></div>`);
    const html = ({ lights: viewLights, board: viewBoard, results: viewResults })[view](data.meet, data.lifters);
    PL.render(root, `<div class="dsp v-${view}">${html}</div>
      <nav class="d-switch">${VIEWS.map((v, i) => `<button class="${v === view ? 'on' : ''}" data-view="${v}">${i + 1} ${v}</button>`).join('')}<button data-full>Full screen</button></nav>`);
  }

  function setView(v) {
    view = v;
    const u = new URL(location.href); u.searchParams.set('view', v); history.replaceState(null, '', u);
    draw();
  }
  const fullscreen = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {});

  root.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.view) setView(b.dataset.view);
    else if (b.dataset.mode) { mode = b.dataset.mode; draw(); }
    else if ('full' in b.dataset) fullscreen();
  });
  document.addEventListener('keydown', e => {
    if (e.key >= '1' && e.key <= '3') setView(VIEWS[+e.key - 1]);
    else if (e.key === 'f' || e.key === 'F') fullscreen();
    else if (e.key === 'm' || e.key === 'M') { mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length]; draw(); }
  });

  if (code) {
    PL.live(code, d => { data = d; loaded = true; draw(); }, () => {});
    PL.tickTimers(() => data && data.meet.state);
  }
  draw();
})();
