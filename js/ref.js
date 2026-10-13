// Referee phone: pick a chair, then tap white or red for the lifter on the platform.
(function () {
  const { api, esc } = PL;
  const root = document.getElementById('app');
  const code = (PL.param('meet') || '').toUpperCase();
  const store = 'plmeet.ref.' + code;
  const saved = (() => { try { return JSON.parse(localStorage.getItem(store)) || {}; } catch (e) { return {}; } })();
  const S = {
    pos: PL.POSITIONS.includes(PL.param('pos')) ? PL.param('pos') : saved.pos || 'head',
    pin: PL.param('pin') || saved.pin || '',
    ok: false, checking: true, data: null, loaded: false, sending: false,
  };
  const LABEL = { left: 'Left referee', head: 'Head referee', right: 'Right referee' };

  async function check() {
    S.checking = true; draw();
    try { S.ok = !!S.pin && await api.refCheck(code, S.pin); } catch (e) { S.ok = false; PL.toast(e.message); }
    S.checking = false;
    if (S.ok) {
      localStorage.setItem(store, JSON.stringify({ pos: S.pos, pin: S.pin }));
      // Keep the phone awake between lifters where the browser allows it.
      if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => {});
    }
    draw();
  }

  const actions = {
    pos: el => { S.pos = el.dataset.v; draw(); },
    join: () => { S.pin = document.getElementById('pin').value.trim(); check(); },
    leave: () => { S.ok = false; draw(); },
    vote: el => PL.run(async () => {
      const st = S.data.meet.state;
      if (S.sending || st.revealed || !st.lifterId) return;
      S.sending = true;
      if (navigator.vibrate) navigator.vibrate(40);
      try {
        await api.refDecide(code, S.pin, S.pos, el.dataset.v, st.lifterId, st.attempt);
        st.lights = Object.assign({}, st.lights, { [S.pos]: el.dataset.v });
      } finally { S.sending = false; draw(); }
    }),
  };

  function draw() {
    if (!code) return PL.render(root, '<div class="r-msg"><b>No meet code</b><span>Scan the referee code from the meet director.</span></div>');
    if (S.checking && !S.ok) return PL.render(root, '<div class="r-msg"><span>Connecting…</span></div>');
    if (!S.ok) return PL.render(root, `<div class="r-join">
        <img src="assets/wlmac-crest-t.png" alt="">
        <h1 class="title">Referee</h1>
        <p class="muted">Meet ${esc(code)}</p>
        <div class="seg">${PL.POSITIONS.map(p => `<button class="${S.pos === p ? 'on' : ''}" data-act="pos" data-v="${p}">${p}</button>`).join('')}</div>
        <label class="field"><span>Referee PIN</span><input id="pin" data-k="pin" inputmode="numeric" autocomplete="off" value="${esc(S.pin)}"></label>
        <button class="btn primary lg block" data-act="join">Start refereeing</button>
      </div>`);
    if (!S.loaded) return PL.render(root, '<div class="r-msg"><span>Loading…</span></div>');
    if (!S.data) return PL.render(root, `<div class="r-msg"><b>Meet ${esc(code)} not found</b></div>`);

    const m = S.data.meet, st = m.state;
    const cur = S.data.lifters.find(l => l.id === st.lifterId);
    const mine = st.lights && st.lights[S.pos];
    const head = `<header class="r-top"><button data-act="leave" title="Change chair">${LABEL[S.pos]}</button><span>${esc(m.name)}</span></header>`;
    if (!cur) return PL.render(root, head + `<div class="r-msg"><b>Waiting for the next lifter</b><span>${PL.LIFTS[st.lift]} · Flight ${esc(st.flight)}</span></div>`);
    const info = `<div class="r-lifter"><span class="eyebrow red">${PL.LIFTS[st.lift]} · Attempt ${st.attempt}</span><b>${esc(cur.name)}</b><span class="r-weight">${PL.fmt(PL.attempt(cur, st.lift, st.attempt - 1).w)} kg</span></div>`;
    if (st.revealed) return PL.render(root, head + info + `<div class="r-result ${st.result}">
        ${PL.lightsHtml(st, 'mid')}<b>${st.result === 'good' ? 'Good lift' : 'No lift'}</b><span>You gave ${mine || 'no decision'}</span></div>`);
    PL.render(root, head + info + `<div class="r-pad">
        <button class="vote white ${mine === 'white' ? 'sel' : ''} ${mine === 'red' ? 'dim' : ''}" data-act="vote" data-v="white">White<small>Good lift</small></button>
        <button class="vote red ${mine === 'red' ? 'sel' : ''} ${mine === 'white' ? 'dim' : ''}" data-act="vote" data-v="red">Red<small>No lift</small></button>
      </div>
      <p class="r-hint">${mine ? 'Sent: ' + mine + '. You can change it until all three referees are in.' : 'Tap your decision.'}</p>`);
  }

  PL.wire(root, actions, {});
  if (code) {
    PL.live(code, d => { S.data = d; S.loaded = true; draw(); }, () => {});
    check();
  } else draw();
})();
