// Director console: create meets, manage lifters, run the platform.
(function () {
  const { api, esc } = PL;
  const root = document.getElementById('app');
  const S = {
    phase: 'boot', user: null, meets: [], row: null, data: null, err: '',
    tab: 'run', resultMode: 'class', showImport: false,
    auto: localStorage.getItem('plmeet.auto') !== '0',
  };
  let refresh = () => {}, autoKey = null, autoTimer = null;

  const meet = () => S.data && S.data.meet;
  const lifters = () => (S.data && S.data.lifters) || [];
  const current = () => lifters().find(l => l.id === meet().state.lifterId) || null;
  const flightOf = l => l.flight || 'A';
  // Every write goes through here: report failures, then re-read so the screen is never stale.
  const act = fn => PL.run(async () => { await fn(); await refresh(); draw(); });
  const patch = p => api.patchState(S.row.id, p);
  const num = v => { const n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? null : n; };

  async function boot() {
    try {
      S.user = await api.user();
      if (!S.user) { S.phase = 'login'; return draw(); }
      if (S.user.role !== 'exec') { S.phase = 'denied'; return draw(); }
      S.meets = await api.listMeets();
    } catch (e) { S.phase = 'error'; S.err = e.message; return draw(); }
    const code = (PL.param('m') || '').toUpperCase();
    S.row = code && S.meets.find(m => m.code === code);
    if (!S.row) { S.phase = 'meets'; return draw(); }
    S.phase = 'meet';
    refresh = PL.live(S.row.code, d => { S.data = d; scheduleAuto(); draw(); }, e => PL.toast('Connection problem: ' + e.message));
    PL.tickTimers(() => meet() && meet().state);
    draw();
  }

  // After the lights come on, move to the next lifter by itself (if the director wants that).
  function scheduleAuto() {
    const m = meet(); if (!m) return;
    const st = m.state;
    const key = st.revealed && S.auto ? [st.lifterId, st.lift, st.attempt].join('|') : null;
    if (key === autoKey) return;
    clearTimeout(autoTimer); autoKey = key;
    if (key) autoTimer = setTimeout(() => {
      const now = meet().state;
      if (now.revealed && [now.lifterId, now.lift, now.attempt].join('|') === key) actions.callNext();
    }, 7000);
  }

  // Put the platform on a given lift / round / flight and call its first lifter.
  function goTo(over) {
    const m = meet(), st = Object.assign({}, m.state, over);
    const next = PL.pending(lifters().filter(l => flightOf(l) === st.flight), st.lift, st.attempt - 1)[0];
    return patch(Object.assign({}, over, PL.clearedPlatform(m.settings), { lifterId: next ? next.id : null }));
  }

  // Record (or clear) a result. If it's the attempt on the platform, the lights follow.
  async function setResult(l, lift, idx, r) {
    const st = meet().state, a = PL.attempt(l, lift, idx);
    await api.setAttempt(l.id, lift, idx, a.w, r);
    if (l.id === st.lifterId && lift === st.lift && idx === st.attempt - 1) {
      const c = r === 'good' ? 'white' : 'red';
      await patch(r ? { lights: { left: c, head: c, right: c }, revealed: true, result: r } : { lights: {}, revealed: false, result: null });
    }
  }

  const actions = {
    login: () => PL.run(async () => {
      const email = document.getElementById('email').value.trim(), pass = document.getElementById('pass').value;
      await api.signIn(email, pass);
      location.reload();
    }),
    signOut: () => PL.run(async () => { await api.signOut(); location.reload(); }),
    createMeet: () => PL.run(async () => {
      const name = document.getElementById('newName').value.trim();
      if (!name) return PL.toast('Give the meet a name.');
      const settings = Object.assign({}, PL.DEFAULT_SETTINGS);
      const row = await api.createMeet({
        code: PL.newCode(), ref_pin: PL.newPin(), name,
        meet_date: document.getElementById('newDate').value || new Date().toISOString().slice(0, 10),
        settings, state: PL.newState(settings),
      });
      location.href = PL.url('director.html', { m: row.code });
    }),
    tab: el => { S.tab = el.dataset.tab; draw(); },
    resultMode: el => { S.resultMode = el.dataset.mode; draw(); },

    // ----- platform -----
    setLift: el => act(() => goTo({ lift: el.dataset.v, attempt: 1 })),
    setRound: el => act(() => goTo({ attempt: +el.dataset.v })),
    setFlight: el => act(() => goTo({ flight: el.dataset.v, attempt: 1 })),
    callNext: () => act(() => {
      const m = meet();
      const next = PL.nextUp(lifters(), m.state), waiting = PL.undeclared(lifters(), m.state);
      if (!next.lifterId && waiting.length) PL.toast("Round " + m.state.attempt + " isn’t finished: no weight entered for " + waiting.map(l => l.name).join(", ") + ".");
      return patch(Object.assign(next, PL.clearedPlatform(m.settings)));
    }),
    setCurrent: el => act(() => patch(Object.assign({ lifterId: el.dataset.l }, PL.clearedPlatform(meet().settings)))),
    decide: el => act(() => { const st = meet().state; return setResult(current(), st.lift, st.attempt - 1, el.dataset.r || null); }),
    cycle: el => act(() => {
      const l = lifters().find(x => x.id === el.dataset.l), lift = el.dataset.lift, idx = +el.dataset.i;
      const r = PL.attempt(l, lift, idx).r;
      return setResult(l, lift, idx, !r ? 'good' : r === 'good' ? 'no' : null);
    }),
    timerStart: () => act(() => { const t = meet().state.timer; return patch({ timer: { running: true, endsAt: PL.now() + PL.timerMs(t), remainingMs: 0 } }); }),
    timerPause: () => act(() => patch({ timer: { running: false, endsAt: 0, remainingMs: PL.timerMs(meet().state.timer) } })),
    timerReset: () => act(() => patch({ timer: { running: false, endsAt: 0, remainingMs: meet().settings.clockSeconds * 1000 } })),

    // ----- lifters -----
    addLifter: () => act(async () => {
      const name = document.getElementById('addName').value.trim();
      if (!name) return PL.toast('Type the lifter’s name first.');
      const lots = lifters().map(l => l.lot || 0);
      await api.saveLifter({
        meet_id: S.row.id, name, sex: document.getElementById('addSex').value,
        bodyweight: num(document.getElementById('addBw').value),
        flight: (document.getElementById('addFlight').value.trim() || 'A').toUpperCase(),
        lot: Math.max(0, ...lots) + 1,
      });
      document.getElementById('addName').value = ''; document.getElementById('addBw').value = '';
      document.getElementById('addName').focus();
    }),
    delLifter: el => { if (confirm('Remove ' + el.dataset.name + ' and all their attempts?')) act(() => api.deleteLifter(el.dataset.l)); },
    toggleImport: () => { S.showImport = !S.showImport; draw(); },
    importLifters: () => act(async () => {
      let lot = Math.max(0, ...lifters().map(l => l.lot || 0));
      const list = document.getElementById('importText').value.split(/\r?\n/).map(line => line.split(/[,\t]/).map(x => x.trim())).filter(c => c[0])
        .map(c => ({ meet_id: S.row.id, name: c[0], sex: /^f/i.test(c[1] || '') ? 'F' : 'M', bodyweight: num(c[2]), flight: (c[3] || 'A').toUpperCase(), team: c[4] || null, lot: ++lot }));
      if (!list.length) return PL.toast('Nothing to import.');
      await api.addLifters(list);
      S.showImport = false; PL.toast('Added ' + list.length + ' lifters.');
    }),

    // ----- setup -----
    newPin: () => { if (confirm('Make a new referee PIN? Referees already signed in will need the new one.')) act(async () => { const pin = PL.newPin(); await api.updateMeet(S.row.id, { ref_pin: pin }); S.row.ref_pin = pin; }); },
    deleteMeet: () => {
      if (prompt('This deletes the meet and every result in it. Type the meet code to confirm.') !== S.row.code) return;
      PL.run(async () => { await api.deleteMeet(S.row.id); location.href = PL.url('director.html'); });
    },
    copy: el => navigator.clipboard.writeText(el.dataset.copy).then(() => PL.toast('Link copied.'), () => PL.toast('Could not copy — select the link instead.')),
    exportCsv: () => {
      const m = meet(), lifts = m.settings.lifts, q = v => '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"';
      const head = ['Place', 'Name', 'Sex', 'Class', 'Bodyweight', 'Team'].concat(...lifts.map(l => [1, 2, 3].map(i => PL.LIFTS[l] + ' ' + i)), lifts.map(l => 'Best ' + PL.LIFTS[l]), ['Total', 'DOTS', 'IPF GL']);
      const rows = PL.sortRows(PL.scoreRows(lifters(), m.settings), 'class').map(r => {
        const l = r.lifter;
        // Failed attempts are written negative, the usual results-sheet convention.
        const att = [].concat(...lifts.map(lift => [0, 1, 2].map(i => { const a = PL.attempt(l, lift, i); return a.w ? (a.r === 'no' ? -a.w : a.r === 'good' ? a.w : '') : ''; })));
        return [r.place || (r.bombed ? 'DQ' : ''), l.name, l.sex, r.cls, r.bw || '', l.team || ''].concat(att, lifts.map(lift => PL.best(l, lift) || ''), [r.total || '', r.dots ? r.dots.toFixed(2) : '', r.gl ? r.gl.toFixed(2) : '']);
      });
      const csv = [head].concat(rows).map(r => r.map(q).join(',')).join('\r\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = m.name.replace(/[^\w]+/g, '-') + '-results.csv'; a.click();
    },
  };

  const changes = {
    weight: (v, el) => act(() => {
      const l = lifters().find(x => x.id === el.dataset.l), w = num(v);
      return api.setAttempt(l.id, el.dataset.lift, +el.dataset.i, w > 0 ? w : null, w > 0 ? PL.attempt(l, el.dataset.lift, +el.dataset.i).r : null);
    }),
    lifter: (v, el) => act(() => {
      const f = el.dataset.f;
      let val = v.trim();
      if (f === 'bodyweight') val = num(val);
      else if (f === 'lot') val = parseInt(val, 10) || null;
      else if (f === 'flight') val = (val || 'A').toUpperCase();
      else if (f === 'name') { if (!val) return PL.toast('A lifter needs a name.'); }
      else if (f !== 'sex') val = val || null;
      return api.saveLifter({ id: el.dataset.l, [f]: val });
    }),
    meetField: (v, el) => act(() => api.updateMeet(S.row.id, { [el.dataset.f]: v })),
    setting: (v, el) => act(async () => {
      const m = meet(), f = el.dataset.f, settings = Object.assign({}, m.settings);
      if (f === 'format') { settings.format = v; settings.lifts = PL.FORMATS[v].lifts; }
      else if (f === 'equipped') settings.equipped = v;
      else { const n = num(v); if (n === null || n < 0) return PL.toast('Enter a number.'); settings[f] = n; }
      await api.updateMeet(S.row.id, { settings });
      if (!settings.lifts.includes(m.state.lift)) await patch({ lift: settings.lifts[0], attempt: 1, lifterId: null });
    }),
    auto: v => { S.auto = v; localStorage.setItem('plmeet.auto', v ? '1' : '0'); scheduleAuto(); },
  };

  // ------------------------------------------------------------------ views
  const seg = (items, value, action) => '<div class="seg">' + items.map(([v, label]) =>
    '<button class="' + (String(v) === String(value) ? 'on' : '') + '" data-act="' + action + '" data-v="' + esc(v) + '">' + esc(label) + '</button>').join('') + '</div>';
  const field = (label, inner) => '<label class="field"><span>' + label + '</span>' + inner + '</label>';
  const shell = (inner, right) => `
    <header class="top">
      <a class="brand" href="${PL.url('index.html')}"><img src="assets/wlmac-crest-t.png" alt=""><span><b>WLMAC Meet</b><small>Director · build ${esc(PL.build)}</small></span></a>
      <div class="top-right">${right || ''}</div>
    </header>${PL.demo ? '<div class="demo-strip">Demo mode — data lives only in this browser. Open the display and referee pages in other tabs to see them sync.</div>' : ''}
    <main class="wrap">${inner}</main>`;

  function draw() {
    const out = S.user && S.phase !== 'login' ? `<span class="who">${esc(S.user.name)}</span><button class="btn ghost sm" data-act="signOut">Sign out</button>` : '';
    if (S.phase === 'boot') return PL.render(root, shell('<p class="muted">Loading…</p>'));
    if (S.phase === 'login') return PL.render(root, shell(`
      <div class="card narrow">
        <h1 class="title">Exec log in</h1>
        <p class="muted">Use your WLMAC Fitness Club exec account to run a meet.</p>
        ${field('School email', '<input id="email" type="email" placeholder="you@wlmac.ca" autocomplete="username">')}
        ${field('Password', '<input id="pass" type="password" autocomplete="current-password">')}
        <button class="btn primary lg block" data-act="login">Log in</button>
      </div>`));
    if (S.phase === 'denied') return PL.render(root, shell('<div class="card narrow"><h1 class="title">Execs only</h1><p class="muted">Running a meet needs an exec account. Ask an exec to set your role in the club app.</p></div>', out));
    if (S.phase === 'error') return PL.render(root, shell(`<div class="card narrow"><h1 class="title">Can’t reach the meet database</h1><p class="muted">${esc(S.err)}</p><p class="muted">If this is the first run, the tables in <code>supabase/schema.sql</code> haven’t been created yet. You can still <a href="director.html?demo=1">try demo mode</a>.</p></div>`, out));
    if (S.phase === 'meets') return PL.render(root, shell(`
      <h1 class="title">Meets</h1>
      <div class="card">
        <span class="eyebrow">New meet</span>
        <div class="row">
          ${field('Name', '<input id="newName" placeholder="WLMAC Winter Classic">')}
          ${field('Date', '<input id="newDate" type="date" value="' + new Date().toISOString().slice(0, 10) + '">')}
          <button class="btn primary" data-act="createMeet">Create meet</button>
        </div>
      </div>
      <div class="meet-list">${S.meets.map(m => `
        <a class="card meet-item" href="${PL.url('director.html', { m: m.code })}">
          <span><b>${esc(m.name)}</b><small>${esc(m.meet_date)}</small></span><span class="code">${esc(m.code)}</span>
        </a>`).join('') || '<p class="muted">No meets yet — create the first one above.</p>'}</div>`, out));

    const m = meet();
    if (!m) return PL.render(root, shell('<p class="muted">Loading meet…</p>', out));
    const tabs = [['run', 'Run'], ['lifters', 'Lifters'], ['results', 'Results'], ['links', 'Screens & refs'], ['setup', 'Setup']];
    PL.render(root, shell(`
      <div class="meet-head">
        <div><a class="back" href="${PL.url('director.html')}">‹ All meets</a><h1 class="title">${esc(m.name)}</h1></div>
        <span class="code" title="Meet code">${esc(m.code)}</span>
      </div>
      <nav class="tabs">${tabs.map(([k, label]) => `<button class="${S.tab === k ? 'on' : ''}" data-act="tab" data-tab="${k}">${label}</button>`).join('')}</nav>
      ${({ run: viewRun, lifters: viewLifters, results: viewResults, links: viewLinks, setup: viewSetup })[S.tab](m)}`, out));
  }

  function viewRun(m) {
    const st = m.state, set = m.settings, all = lifters(), idx = st.attempt - 1;
    const flight = all.filter(l => flightOf(l) === st.flight);
    const cur = current(), a = cur ? PL.attempt(cur, st.lift, idx) : null;
    const votes = PL.POSITIONS.filter(p => st.lights && st.lights[p]).length;
    const order = PL.roundOrder(flight, st.lift, idx);
    const waiting = PL.undeclared(all, st);
    const status = !cur ? '' : st.revealed
      ? `<span class="verdict ${st.result}">${st.result === 'good' ? 'Good lift' : 'No lift'}</span>`
      : `<span class="muted">${votes ? votes + ' of 3 referees in' : 'Waiting for referees'}</span>`;

    const platform = cur ? `
      <div class="plat-name">${esc(cur.name)}</div>
      <div class="plat-meta">${[PL.weightClass(cur.sex, +cur.bodyweight) && PL.weightClass(cur.sex, +cur.bodyweight) + ' kg class', cur.bodyweight && 'BW ' + PL.fmt(cur.bodyweight), st.lift === 'squat' && cur.rack_squat && 'Rack ' + cur.rack_squat, st.lift === 'bench' && cur.rack_bench && 'Rack ' + cur.rack_bench].filter(Boolean).map(esc).join(' · ')}</div>
      <div class="plat-weight">${PL.fmt(a.w) || '—'}<small>kg</small></div>
      ${PL.platesHtml(a.w, set)}
      <div class="plat-row">${PL.lightsHtml(st, 'sm')}${status}</div>
      <div class="plat-row">
        <span class="clock" data-timer>${PL.clockText(PL.timerMs(st.timer))}</span>
        ${st.timer.running ? '<button class="btn secondary sm" data-act="timerPause">Pause</button>' : '<button class="btn secondary sm" data-act="timerStart">Start clock</button>'}
        <button class="btn ghost sm" data-act="timerReset">Reset</button>
      </div>
      <div class="plat-row">
        <button class="btn white" data-act="decide" data-r="good">Good lift</button>
        <button class="btn primary" data-act="decide" data-r="no">No lift</button>
        ${st.revealed || votes ? '<button class="btn ghost sm" data-act="decide" data-r="">Clear decision</button>' : ''}
      </div>` : `
      <div class="plat-empty">Nobody on the platform</div>
      <p class="muted">${waiting.length
        ? "Round " + st.attempt + " is waiting on attempt weights for " + esc(waiting.map(l => l.name).join(", ")) + ". Enter them in the sheet below, or pick the next round above to carry on without them."
        : flight.length && flight.every(l => PL.attempt(l, st.lift, idx).r)
          ? (st.attempt < 3 ? "Round " + st.attempt + " is finished. Call the next lifter to start round " + (st.attempt + 1) + "." : "Flight " + esc(st.flight) + " has finished " + PL.LIFTS[st.lift].toLowerCase() + ". Pick the next flight or lift above.")
          : "Enter attempt weights in the sheet below, then call the next lifter."}</p>`;

    const sheetRows = flight.slice().sort((x, y) => ((x.lot || 9999) - (y.lot || 9999)) || x.name.localeCompare(y.name)).map(l => `
      <tr class="${cur && l.id === cur.id ? 'cur-row' : ''}">
        <td class="num">${l.lot || ''}</td><td class="name">${esc(l.name)}</td><td class="num">${PL.fmt(l.bodyweight)}</td>
        ${set.lifts.map(lift => [0, 1, 2].map(i => {
          const at = PL.attempt(l, lift, i), isCur = cur && l.id === cur.id && lift === st.lift && i === idx;
          return `<td class="cell ${at.r || ''}${isCur ? ' cur' : ''}${i === 0 ? ' first' : ''}">
            <input data-k="w|${l.id}|${lift}|${i}" data-chg="weight" data-l="${l.id}" data-lift="${lift}" data-i="${i}" data-orig="${PL.fmt(at.w)}" value="${PL.fmt(at.w)}" inputmode="decimal" aria-label="${esc(l.name)} ${PL.LIFTS[lift]} ${i + 1}">
            <button data-act="cycle" data-l="${l.id}" data-lift="${lift}" data-i="${i}" ${at.w ? '' : 'disabled'} title="Click to cycle: good, no lift, clear">${at.r === 'good' ? '✓' : at.r === 'no' ? '✕' : '·'}</button></td>`;
        }).join('')).join('')}
        <td class="num total">${PL.fmt(PL.total(l, set.lifts)) === '0' ? '—' : PL.fmt(PL.total(l, set.lifts))}</td>
      </tr>`).join('');

    return `
      <div class="run-bar">
        ${seg(set.lifts.map(l => [l, PL.LIFTS[l]]), st.lift, 'setLift')}
        ${seg([[1, 'Round 1'], [2, 'Round 2'], [3, 'Round 3']], st.attempt, 'setRound')}
        ${seg(PL.flights(all).map(f => [f, 'Flight ' + f]), st.flight, 'setFlight')}
        <label class="check"><input type="checkbox" data-chg="auto" ${S.auto ? 'checked' : ''}> Auto-advance after the lights</label>
      </div>
      <div class="run-grid">
        <section class="card platform">
          <span class="eyebrow red">On the platform · ${PL.LIFTS[st.lift]} ${st.attempt}</span>
          ${platform}
          <button class="btn primary lg block" data-act="callNext">${cur ? 'Next lifter' : 'Call next lifter'}</button>
        </section>
        <section class="card">
          <span class="eyebrow">Lifting order · Flight ${esc(st.flight)}</span>
          <ol class="order" data-scroll="order">${order.map(l => {
            const at = PL.attempt(l, st.lift, idx);
            return `<li class="${cur && l.id === cur.id ? 'cur' : ''} ${at.r ? 'done ' + at.r : ''}">
              <button data-act="setCurrent" data-l="${l.id}" ${at.w && !at.r ? '' : 'disabled'} title="Put this lifter on the platform">
                <span class="name">${esc(l.name)}</span><span class="w">${at.w ? PL.fmt(at.w) + ' kg' : 'no attempt'}</span>
              </button></li>`;
          }).join('') || '<li class="muted">No lifters in this flight.</li>'}</ol>
        </section>
      </div>
      <section class="card sheet" data-scroll="sheet">
        <table class="tbl">
          <thead><tr><th class="num">Lot</th><th>Lifter</th><th class="num">BW</th>${set.lifts.map(l => '<th colspan="3" class="lift-h">' + PL.LIFTS[l] + '</th>').join('')}<th class="num">Total</th></tr></thead>
          <tbody>${sheetRows || '<tr><td colspan="' + (4 + set.lifts.length * 3) + '" class="empty">No lifters in flight ' + esc(st.flight) + ' — add them on the Lifters tab.</td></tr>'}</tbody>
        </table>
      </section>`;
  }

  function viewLifters() {
    const inp = (l, f, extra) => `<input data-k="l|${l.id}|${f}" data-chg="lifter" data-l="${l.id}" data-f="${f}" data-orig="${esc(f === 'bodyweight' ? PL.fmt(l[f]) : l[f] === null || l[f] === undefined ? '' : l[f])}" value="${esc(f === 'bodyweight' ? PL.fmt(l[f]) : l[f] === null || l[f] === undefined ? '' : l[f])}" ${extra || ''}>`;
    return `
      <div class="card">
        <span class="eyebrow">Add a lifter</span>
        <div class="row">
          ${field('Name', '<input id="addName" placeholder="Full name">')}
          ${field('Sex', '<select id="addSex"><option value="M">M</option><option value="F">F</option></select>')}
          ${field('Bodyweight (kg)', '<input id="addBw" inputmode="decimal" class="short">')}
          ${field('Flight', '<input id="addFlight" value="A" class="short">')}
          <button class="btn primary" data-act="addLifter">Add</button>
          <button class="btn ghost" data-act="toggleImport">${S.showImport ? 'Cancel import' : 'Paste a list'}</button>
        </div>
        ${S.showImport ? `<div class="import">
          <p class="muted">One lifter per line: <code>Name, M or F, bodyweight, flight, team</code> — only the name is required. Pasting columns from a spreadsheet works too.</p>
          <textarea id="importText" rows="6" placeholder="Sam Okafor, M, 72.4, A, Grade 10"></textarea>
          <button class="btn primary" data-act="importLifters">Import</button></div>` : ''}
      </div>
      <section class="card sheet" data-scroll="lifters">
        <table class="tbl edit">
          <thead><tr><th>Lot</th><th>Name</th><th>Sex</th><th>BW (kg)</th><th>Class</th><th>Team / grade</th><th>Flight</th><th>Squat rack</th><th>Bench rack</th><th></th></tr></thead>
          <tbody>${lifters().map(l => `<tr>
            <td>${inp(l, 'lot', 'class="short" inputmode="numeric"')}</td><td>${inp(l, 'name')}</td>
            <td><select data-k="l|${l.id}|sex" data-chg="lifter" data-l="${l.id}" data-f="sex"><option value="M" ${l.sex === 'M' ? 'selected' : ''}>M</option><option value="F" ${l.sex === 'F' ? 'selected' : ''}>F</option></select></td>
            <td>${inp(l, 'bodyweight', 'class="short" inputmode="decimal"')}</td><td class="num">${PL.weightClass(l.sex, +l.bodyweight) || '—'}</td>
            <td>${inp(l, 'team')}</td><td>${inp(l, 'flight', 'class="short"')}</td><td>${inp(l, 'rack_squat', 'class="short"')}</td><td>${inp(l, 'rack_bench', 'class="short"')}</td>
            <td><button class="btn ghost sm" data-act="delLifter" data-l="${l.id}" data-name="${esc(l.name)}">Remove</button></td></tr>`).join('') || '<tr><td colspan="10" class="empty">No lifters yet.</td></tr>'}</tbody>
        </table>
      </section>
      <p class="muted">Weight class is worked out from bodyweight (IPF classes). Lot numbers break ties in the lifting order.</p>`;
  }

  function viewResults(m) {
    return `<div class="run-bar">
        <div class="seg">${Object.entries(PL.RESULT_MODES).map(([k, label]) => `<button class="${S.resultMode === k ? 'on' : ''}" data-act="resultMode" data-mode="${k}">${label}</button>`).join('')}</div>
        <button class="btn secondary sm" data-act="exportCsv">Download CSV</button>
      </div>
      <section class="card sheet" data-scroll="results">${PL.resultsHtml(lifters(), m.settings, S.resultMode)}</section>
      ${m.settings.format === 'pp' ? '<p class="muted">IPF GL points aren’t defined for push-pull, so that column stays empty.</p>' : ''}`;
  }

  function viewLinks(m) {
    const qr = url => { try { const q = window.qrcode(0, 'M'); q.addData(url); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); } catch (e) { return ''; } };
    const link = (title, sub, url, withQr) => `<div class="card link">
        ${withQr ? '<div class="qr">' + qr(url) + '</div>' : ''}
        <div class="link-body"><b>${title}</b><small>${sub}</small>
          <input readonly value="${esc(url)}" onfocus="this.select()">
          <div class="row"><a class="btn secondary sm" href="${esc(url)}" target="_blank" rel="noopener">Open</a><button class="btn ghost sm" data-act="copy" data-copy="${esc(url)}">Copy link</button></div>
        </div></div>`;
    const d = view => PL.absUrl('display.html', { meet: m.code, view });
    const r = pos => PL.absUrl('ref.html', { meet: m.code, pos, pin: S.row.ref_pin });
    return `
      <h2 class="sub">Screens</h2>
      <p class="muted">Open these on the computer driving the projector or TV. Press <kbd>F</kbd> for full screen and <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> to switch views.</p>
      <div class="links">
        ${link('Lights', 'Lifter, attempt weight, clock and the three referee lights', d('lights'))}
        ${link('Scoreboard', 'Every attempt in the flight, with totals, DOTS and GL', d('board'))}
        ${link('Results', 'Rankings by class, DOTS or GL', d('results'))}
      </div>
      <h2 class="sub">Referees</h2>
      <p class="muted">Each referee scans their own code with their phone camera. The codes include the referee PIN (<b>${esc(S.row.ref_pin)}</b>), so only show them to your referees.</p>
      <div class="links">
        ${link('Left referee', 'Phone', r('left'), true)}
        ${link('Head referee', 'Phone', r('head'), true)}
        ${link('Right referee', 'Phone', r('right'), true)}
      </div>
      ${location.protocol === 'file:' || /^(localhost|127\.)/.test(location.hostname) ? '<p class="muted">These links point at this computer, so phones can’t open them yet. Host the folder (for example on GitHub Pages) and open the director page from there.</p>' : ''}`;
  }

  function viewSetup(m) {
    const set = m.settings;
    const sInp = (f, label) => field(label, `<input data-k="s|${f}" data-chg="setting" data-f="${f}" data-orig="${PL.fmt(set[f])}" value="${PL.fmt(set[f])}" inputmode="decimal" class="short">`);
    return `
      <div class="card">
        <span class="eyebrow">Meet</span>
        <div class="row">
          ${field('Name', `<input data-k="m|name" data-chg="meetField" data-f="name" data-orig="${esc(m.name)}" value="${esc(m.name)}">`)}
          ${field('Date', `<input type="date" data-k="m|date" data-chg="meetField" data-f="meet_date" data-orig="${esc(m.meet_date)}" value="${esc(m.meet_date)}">`)}
          ${field('Format', `<select data-k="s|format" data-chg="setting" data-f="format">${Object.entries(PL.FORMATS).map(([k, f]) => `<option value="${k}" ${set.format === k ? 'selected' : ''}>${f.label}</option>`).join('')}</select>`)}
        </div>
        <label class="check"><input type="checkbox" data-chg="setting" data-f="equipped" ${set.equipped ? 'checked' : ''}> Equipped meet (changes the IPF GL formula)</label>
      </div>
      <div class="card">
        <span class="eyebrow">Platform</span>
        <div class="row">${sInp('barKg', 'Bar (kg)')}${sInp('collarKg', 'Each collar (kg)')}${sInp('clockSeconds', 'Clock (seconds)')}</div>
        <p class="muted">Bar and collar weights drive the plate-loading picture on the lights screen.</p>
      </div>
      <div class="card">
        <span class="eyebrow">Referee PIN</span>
        <div class="row"><span class="code">${esc(S.row.ref_pin)}</span><button class="btn secondary sm" data-act="newPin">New PIN</button></div>
        <p class="muted">Referees need the meet code and this PIN to send decisions. Anyone with just the meet code can only watch.</p>
      </div>
      <div class="card danger">
        <span class="eyebrow">Delete meet</span>
        <div class="row"><p class="muted">Removes the meet, its lifters and all results. This can’t be undone.</p><button class="btn secondary sm" data-act="deleteMeet">Delete this meet</button></div>
      </div>`;
  }

  PL.wire(root, actions, changes);
  boot();
})();
