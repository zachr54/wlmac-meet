// Data layer. Two interchangeable backends with the same methods:
//   supabaseApi() — the real thing (see supabase/schema.sql)
//   localApi()    — demo mode: one browser's localStorage, synced across its tabs
(function () {
  const PL = window.PL = window.PL || {};
  const cfg = window.PL_CONFIG || {};
  const qs = new URLSearchParams(location.search);

  PL.demo = qs.has('demo') || !cfg.SUPABASE_URL;
  PL.param = k => qs.get(k);
  // Links between pages keep demo mode switched on.
  PL.url = (page, params) => {
    const p = new URLSearchParams(params || {});
    if (PL.demo) p.set('demo', '1');
    const s = p.toString();
    return page + (s ? '?' + s : '');
  };
  PL.absUrl = (page, params) => new URL(PL.url(page, params), location.href).href;

  // A page served from the browser's cache can be an older release than the site. Compare with
  // version.txt (never cached) and reload once if so. To release: bump the number in version.txt
  // and in every page's PL_BUILD / ?v= tags.
  PL.build = window.PL_BUILD || 'dev';
  if (location.protocol.startsWith('http')) {
    fetch('version.txt', { cache: 'no-store' }).then(r => (r.ok ? r.text() : '')).then(v => {
      v = v.trim();
      if (!v || v === PL.build || sessionStorage.getItem('plmeet.reloaded') === v) return;
      sessionStorage.setItem('plmeet.reloaded', v);
      location.reload();
    }).catch(() => {});
  }

  const pick = (alphabet, n) => {
    const buf = new Uint32Array(n);
    crypto.getRandomValues(buf);
    return Array.from(buf, x => alphabet[x % alphabet.length]).join('');
  };
  PL.newCode = () => pick('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 6);
  PL.newPin = () => pick('0123456789', 6);

  const LIFTER_COLS = ['name', 'sex', 'bodyweight', 'team', 'flight', 'lot', 'rack_squat', 'rack_bench'];
  const lifterCols = l => { const o = {}; LIFTER_COLS.forEach(k => { if (k in l) o[k] = l[k]; }); return o; };

  // ---------------------------------------------------------------- Supabase
  function supabaseApi() {
    const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    const must = r => { if (r.error) throw new Error(r.error.message); return r.data; };
    return {
      async user() {
        const { data } = await sb.auth.getSession();
        if (!data.session) return null;
        return must(await sb.from('profiles').select('id,name,role').eq('id', data.session.user.id).maybeSingle());
      },
      async signIn(email, pass) {
        must(await sb.auth.signInWithPassword({ email, password: pass }));
        return this.user();
      },
      async signOut() { await sb.auth.signOut(); },

      async listMeets() { return must(await sb.from('pl_meets').select('*').order('meet_date', { ascending: false })); },
      async createMeet(m) { return must(await sb.from('pl_meets').insert(m).select().single()); },
      async updateMeet(id, patch) { must(await sb.from('pl_meets').update(patch).eq('id', id)); },
      async deleteMeet(id) { must(await sb.from('pl_meets').delete().eq('id', id)); },
      async patchState(meetId, patch) { must(await sb.rpc('pl_patch_state', { p_meet: meetId, p_patch: patch })); },

      async saveLifter(l) {
        if (l.id) must(await sb.from('pl_lifters').update(lifterCols(l)).eq('id', l.id));
        else must(await sb.from('pl_lifters').insert(Object.assign({ meet_id: l.meet_id }, lifterCols(l))));
      },
      async addLifters(list) { must(await sb.from('pl_lifters').insert(list)); },
      async deleteLifter(id) { must(await sb.from('pl_lifters').delete().eq('id', id)); },
      async setAttempt(lifterId, lift, idx, w, r) {
        must(await sb.rpc('pl_set_attempt', { p_lifter: lifterId, p_lift: lift, p_idx: idx, p_weight: w, p_result: r }));
      },

      async getPublic(code) { return must(await sb.rpc('pl_get_meet', { p_code: code })); },
      async refCheck(code, pin) { return must(await sb.rpc('pl_ref_check', { p_code: code, p_pin: pin })); },
      async refDecide(code, pin, pos, decision, lifterId, attempt) {
        must(await sb.rpc('pl_ref_decide', { p_code: code, p_pin: pin, p_pos: pos, p_decision: decision, p_lifter: lifterId, p_attempt: attempt }));
      },
      subscribe(code, cb) {
        const ch = sb.channel('pl:' + code).on('broadcast', { event: 'changed' }, cb).subscribe();
        return () => sb.removeChannel(ch);
      },
    };
  }

  // ---------------------------------------------------------------- Demo (localStorage)
  function localApi() {
    const KEY = 'plmeet.demo';
    const listeners = new Set();
    const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || seed(); } catch (e) { return seed(); } };
    const write = db => { localStorage.setItem(KEY, JSON.stringify(db)); listeners.forEach(cb => cb()); };
    window.addEventListener('storage', e => { if (e.key === KEY) listeners.forEach(cb => cb()); });
    const id = () => crypto.randomUUID();
    const meetByCode = (db, code) => db.meets.find(m => m.code === String(code).toUpperCase());

    function seed() {
      const settings = Object.assign({}, PL.DEFAULT_SETTINGS);
      const meet = { id: id(), code: 'DEMO', ref_pin: '000000', name: 'Demo Meet', meet_date: new Date().toISOString().slice(0, 10), settings, state: PL.newState(settings), created_at: new Date().toISOString() };
      const people = [
        ['Sam Okafor', 'M', 72.4, 'Grade 10', 'A', 120, 75, 150], ['Mia Kowalczyk', 'F', 58.9, 'Grade 11', 'A', 80, 42.5, 105],
        ['Ife Balogun', 'M', 88.2, 'Grade 12', 'A', 165, 105, 200], ['Amara Singh', 'F', 51.3, 'Grade 9', 'A', 60, 32.5, 85],
        ['Theo Nguyen', 'M', 64.8, 'Grade 9', 'B', 95, 60, 125], ['Lena Voss', 'F', 66.5, 'Grade 12', 'B', 92.5, 50, 122.5],
        ['Cody Tran', 'M', 80.1, 'Grade 11', 'B', 142.5, 92.5, 180], ['Jonah Reyes', 'M', 97.6, 'Grade 10', 'B', 155, 100, 190],
      ];
      const lifters = people.map((p, i) => {
        const attempts = PL.emptyAttempts();
        attempts.squat[0].w = p[5]; attempts.bench[0].w = p[6]; attempts.deadlift[0].w = p[7];
        return { id: id(), meet_id: meet.id, name: p[0], sex: p[1], bodyweight: p[2], team: p[3], flight: p[4], lot: i + 1, rack_squat: String(8 + (i % 6)), rack_bench: String(4 + (i % 4)), attempts };
      });
      const db = { meets: [meet], lifters };
      localStorage.setItem(KEY, JSON.stringify(db));
      return db;
    }

    return {
      async user() { return { id: 'demo', name: 'Demo Exec', role: 'exec' }; },
      async signIn() { return this.user(); },
      async signOut() {},

      async listMeets() { return read().meets; },
      async createMeet(m) { const db = read(); const row = Object.assign({ id: id(), created_at: new Date().toISOString() }, m); db.meets.unshift(row); write(db); return row; },
      async updateMeet(mid, patch) { const db = read(); Object.assign(db.meets.find(m => m.id === mid), patch); write(db); },
      async deleteMeet(mid) { const db = read(); db.meets = db.meets.filter(m => m.id !== mid); db.lifters = db.lifters.filter(l => l.meet_id !== mid); write(db); },
      async patchState(mid, patch) { const db = read(); const m = db.meets.find(x => x.id === mid); Object.assign(m.state, patch); write(db); },

      async saveLifter(l) {
        const db = read();
        if (l.id) Object.assign(db.lifters.find(x => x.id === l.id), lifterCols(l));
        else db.lifters.push(Object.assign({ id: id(), meet_id: l.meet_id, attempts: PL.emptyAttempts() }, lifterCols(l)));
        write(db);
      },
      async addLifters(list) { const db = read(); list.forEach(l => db.lifters.push(Object.assign({ id: id(), attempts: PL.emptyAttempts() }, l))); write(db); },
      async deleteLifter(lid) { const db = read(); db.lifters = db.lifters.filter(l => l.id !== lid); write(db); },
      async setAttempt(lid, lift, idx, w, r) { const db = read(); db.lifters.find(l => l.id === lid).attempts[lift][idx] = { w, r }; write(db); },

      async getPublic(code) {
        const db = read(); const m = meetByCode(db, code);
        if (!m) return null;
        const meet = Object.assign({}, m); delete meet.ref_pin;
        const lifters = db.lifters.filter(l => l.meet_id === m.id).sort((a, b) => ((a.lot || 9999) - (b.lot || 9999)) || a.name.localeCompare(b.name));
        return { meet, lifters, serverNow: Date.now() };
      },
      async refCheck(code, pin) { const m = meetByCode(read(), code); return !!m && m.ref_pin === pin; },
      // Mirrors pl_ref_decide in supabase/schema.sql.
      async refDecide(code, pin, pos, decision, lifterId, attempt) {
        const db = read(); const m = meetByCode(db, code);
        if (!m || m.ref_pin !== pin) throw new Error('Wrong meet code or referee PIN');
        const st = m.state;
        if (!st.lifterId || st.lifterId !== lifterId || st.attempt !== attempt) throw new Error('The platform has moved on');
        if (st.revealed) throw new Error('Decision is already in');
        st.lights = Object.assign({}, st.lights, { [pos]: decision });
        if (PL.POSITIONS.every(p => st.lights[p])) {
          st.result = PL.verdict(st.lights); st.revealed = true;
          db.lifters.find(l => l.id === lifterId).attempts[st.lift][attempt - 1].r = st.result;
        }
        write(db);
      },
      subscribe(code, cb) { listeners.add(cb); return () => listeners.delete(cb); },
    };
  }

  // Pages that only build links (the landing page) don't load the Supabase library.
  PL.api = PL.demo ? localApi() : window.supabase ? supabaseApi() : null;

  // Clock shared by every screen: device time corrected to the server's, so timers agree.
  PL.offset = 0;
  PL.now = () => Date.now() + PL.offset;

  // Keep one meet's public data fresh: push pings when they arrive, slow polling as the safety net.
  PL.live = (code, onData, onError) => {
    let busy = false, again = false, last;
    async function refresh() {
      if (busy) { again = true; return; }
      busy = true;
      try {
        const sent = Date.now();
        const data = await PL.api.getPublic(code);
        if (data) PL.offset = data.serverNow - (sent + Date.now()) / 2;
        // Only redraw when something actually changed, so routine polling never disturbs the page.
        const sig = data ? JSON.stringify([data.meet, data.lifters]) : 'none';
        if (sig !== last) { last = sig; onData(data); }
      } catch (e) { if (onError) onError(e); }
      busy = false;
      if (again) { again = false; refresh(); }
    }
    PL.api.subscribe(code, refresh);
    setInterval(refresh, PL.demo ? 15000 : 4000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    refresh();
    return refresh;
  };
})();
