// Small rendering helpers shared by every page.
(function () {
  const PL = window.PL = window.PL || {};

  PL.esc = s => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Replace a region's HTML without disturbing whoever is typing in it: the focused field
  // (matched by data-k), its half-typed value, and scroll positions all survive the redraw.
  PL.render = (root, html) => {
    const a = document.activeElement;
    const key = a && root.contains(a) && a.dataset.k;
    let val, start, end;
    if (key) { val = a.value; try { start = a.selectionStart; end = a.selectionEnd; } catch (e) {} }
    const scrolls = Array.from(root.querySelectorAll('[data-scroll]'), n => [n.dataset.scroll, n.scrollTop, n.scrollLeft]);
    root.innerHTML = html;
    scrolls.forEach(([k, top, left]) => { const n = root.querySelector('[data-scroll="' + k + '"]'); if (n) { n.scrollTop = top; n.scrollLeft = left; } });
    if (key) {
      const n = root.querySelector('[data-k="' + CSS.escape(key) + '"]');
      if (n) { n.focus(); if (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA') { n.value = val; try { n.setSelectionRange(start, end); } catch (e) {} } }
    }
  };

  // Event wiring by attribute:
  //   data-act="name"  click  -> actions.name(el, event)
  //   data-chg="name"  edit   -> changes.name(el.value, el)   (text fields commit on blur or Enter)
  PL.wire = (root, actions, changes) => {
    root.addEventListener('click', e => {
      const el = e.target.closest('[data-act]');
      if (el && root.contains(el) && !el.disabled) actions[el.dataset.act](el, e);
    });
    const commit = el => {
      const orig = el.dataset.orig === undefined ? '' : el.dataset.orig;
      if (el.value === orig) return;
      el.dataset.orig = el.value;
      changes[el.dataset.chg](el.value, el);
    };
    const isText = el => (el.tagName === 'INPUT' && el.type !== 'checkbox') || el.tagName === 'TEXTAREA';
    root.addEventListener('focusout', e => { const el = e.target; if (el.dataset && el.dataset.chg && isText(el)) commit(el); });
    root.addEventListener('keydown', e => { const el = e.target; if (e.key === 'Enter' && el.dataset && el.dataset.chg && el.tagName === 'INPUT') { commit(el); el.select && el.select(); } });
    root.addEventListener('change', e => {
      const el = e.target;
      if (!el.dataset || !el.dataset.chg || isText(el)) return;
      changes[el.dataset.chg](el.type === 'checkbox' ? el.checked : el.value, el);
    });
  };

  let toastTimer;
  PL.toast = msg => {
    let t = document.getElementById('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  };
  // Run an async action; surface failures instead of swallowing them.
  PL.run = async fn => { try { return await fn(); } catch (e) { console.error(e); PL.toast(e.message || 'Something went wrong'); } };

  // ---------- clock ----------
  PL.timerMs = timer => !timer ? 0 : timer.running ? Math.max(0, timer.endsAt - PL.now()) : Math.max(0, timer.remainingMs || 0);
  PL.clockText = ms => { const s = Math.ceil(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  // Any element with data-timer keeps itself up to date from the current meet state.
  PL.tickTimers = getState => setInterval(() => {
    const st = getState(); if (!st) return;
    const ms = PL.timerMs(st.timer);
    document.querySelectorAll('[data-timer]').forEach(n => {
      n.textContent = PL.clockText(ms);
      n.classList.toggle('low', ms <= 10000 && st.timer.running);
      n.classList.toggle('out', ms <= 0);
    });
  }, 200);

  // ---------- shared fragments ----------
  // Three referee lights. Before the reveal they only show who has voted, never which way.
  PL.lightsHtml = (state, cls) => '<div class="lights ' + (cls || '') + '">' + PL.POSITIONS.map(p => {
    const v = state.lights && state.lights[p];
    const mode = state.revealed && v ? v : v ? 'in' : '';
    return '<i class="light ' + mode + '" title="' + p + '"></i>';
  }).join('') + '</div>';

  PL.platesHtml = (weight, settings) => {
    if (!(+weight > 0)) return '';
    const load = PL.plates(weight, settings.barKg, settings.collarKg);
    const chips = load.plates.map(p => '<i class="plate p' + String(p).replace('.', '_') + '"><b>' + p + '</b></i>').join('');
    const note = load.short ? '<span class="plate-note">' + (load.short > 0 ? '+' : '') + PL.fmt(load.short) + ' kg not loadable</span>' : '';
    return '<div class="plates"><span class="plate-bar"></span>' + chips + '<i class="plate collar"></i><span class="plate-end"></span>' + note + '</div>';
  };

  PL.attemptCell = (lifter, lift, idx, current) => {
    const a = PL.attempt(lifter, lift, idx);
    const cls = (a.r === 'good' ? ' good' : a.r === 'no' ? ' no' : '') + (current ? ' cur' : '');
    return '<td class="att' + cls + '">' + PL.fmt(a.w) + '</td>';
  };

  PL.RESULT_MODES = { class: 'By class', dots: 'DOTS', gl: 'IPF GL' };
  PL.resultsHtml = (lifters, settings, mode) => {
    const rows = PL.sortRows(PL.scoreRows(lifters, settings), mode);
    const lifts = settings.lifts;
    let lastGroup = null, body = '';
    rows.forEach((r, i) => {
      const l = r.lifter;
      const group = (l.sex === 'F' ? 'Women' : 'Men') + ' · ' + (r.cls ? r.cls + ' kg' : 'No bodyweight');
      if (mode === 'class' && group !== lastGroup) { body += '<tr class="group"><td colspan="' + (7 + lifts.length) + '">' + group + '</td></tr>'; lastGroup = group; }
      const rank = mode === 'class' ? (r.place || (r.bombed ? 'DQ' : '—')) : (r.total > 0 ? i + 1 : (r.bombed ? 'DQ' : '—'));
      body += '<tr><td class="num rank">' + rank + '</td><td class="name">' + PL.esc(l.name) + '</td><td>' + PL.esc(l.team || '') + '</td>' +
        '<td class="num">' + (r.bw ? PL.fmt(r.bw) : '') + '</td>' +
        lifts.map(lift => '<td class="num">' + (PL.fmt(PL.best(l, lift)) === '0' ? '—' : PL.fmt(PL.best(l, lift))) + '</td>').join('') +
        '<td class="num total">' + (r.total ? PL.fmt(r.total) : '—') + '</td>' +
        '<td class="num' + (mode === 'dots' ? ' hot' : '') + '">' + PL.fmtScore(r.dots) + '</td>' +
        '<td class="num' + (mode === 'gl' ? ' hot' : '') + '">' + PL.fmtScore(r.gl) + '</td></tr>';
    });
    return '<table class="tbl results"><thead><tr><th class="num">#</th><th>Lifter</th><th>Team</th><th class="num">BW</th>' +
      lifts.map(lift => '<th class="num">' + PL.LIFTS[lift] + '</th>').join('') +
      '<th class="num">Total</th><th class="num">DOTS</th><th class="num">GL</th></tr></thead><tbody>' +
      (body || '<tr><td colspan="' + (7 + lifts.length) + '" class="empty">No lifters yet.</td></tr>') + '</tbody></table>';
  };
})();
