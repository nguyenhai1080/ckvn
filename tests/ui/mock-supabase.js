// Supabase giả lập (thay cho supabase-js khi kiểm thử giao diện). Dữ liệu trong window.__mockDB.
(() => {
  const DB = window.__mockDB;
  const listeners = [];
  let session = JSON.parse(sessionStorage.getItem('mock-sess') || 'null');
  const save = () => sessionStorage.setItem('mock-sess', JSON.stringify(session));
  const emit = (ev) => listeners.forEach(cb => cb(ev, session));
  const uid = () => session?.user?.id;
  const OWN = { watchlist: 1, profiles: 1, alert_log: 1 };

  function builder(table) {
    let rows = null, op = 'select', payload = null, filters = [], order = [], lim = null, single = false;
    const b = {
      select() { return b; },
      eq(k, v) { filters.push(r => String(r[k]) === String(v)); return b; },
      order(k, o = {}) { order.push([k, o.ascending !== false]); return b; },
      limit(n) { lim = n; return b; },
      maybeSingle() { single = true; return b; },
      upsert(p) { op = 'upsert'; payload = [].concat(p); return b; },
      update(p) { op = 'update'; payload = p; return b; },
      delete() { op = 'delete'; return b; },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej); },
    };
    function run() {
      const t = DB[table];
      const vis = r => !OWN[table] || r.user_id === uid();
      if (OWN[table] && !uid()) return { data: single ? null : [], error: null };
      if (op === 'upsert') { payload.forEach(p => { const r = { user_id: uid(), added_at: new Date().toISOString(), ...p }; if (!t.some(x => x.user_id === r.user_id && x.symbol === r.symbol)) t.push(r); }); return { data: null, error: null }; }
      const hit = t.filter(r => vis(r) && filters.every(f => f(r)));
      if (op === 'delete') { hit.forEach(r => t.splice(t.indexOf(r), 1)); return { data: null, error: null }; }
      if (op === 'update') { hit.forEach(r => Object.assign(r, payload)); return { data: null, error: null }; }
      let out = hit.map(r => ({ ...r }));
      for (const [k, asc] of order.slice().reverse()) out.sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (asc ? 1 : -1));
      if (lim) out = out.slice(0, lim);
      return { data: single ? out[0] || null : out, error: null };
    }
    return b;
  }

  window.supabase = {
    createClient() {
      return {
        from: builder,
        async rpc(name) {
          const p = DB.profiles.find(x => x.user_id === uid());
          if (name === 'create_telegram_link') { p.telegram_link_code = 'c0de'.padEnd(32, '0'); setTimeout(() => { p.telegram_chat_id = 777; }, 1500); return { data: p.telegram_link_code, error: null }; }
          if (name === 'unlink_telegram') { p.telegram_chat_id = null; return { data: null, error: null }; }
        },
        auth: {
          onAuthStateChange(cb) { listeners.push(cb); setTimeout(() => cb('INITIAL_SESSION', session), 0); return { data: { subscription: { unsubscribe() {} } } }; },
          async signInWithPassword({ email, password }) {
            const u = DB.users.find(x => x.email === email && x.password === password);
            if (!u) return { data: {}, error: { message: 'Invalid login credentials' } };
            session = { user: { id: u.id, email } }; save(); setTimeout(() => emit('SIGNED_IN'), 0); return { data: { session }, error: null };
          },
          async signUp({ email }) {
            if (DB.users.some(x => x.email === email)) return { data: { user: { identities: [] } }, error: null };
            return { data: { user: { identities: [{}] }, session: null }, error: null };
          },
          async resetPasswordForEmail() { return { error: null }; },
          async updateUser() { return { data: {}, error: null }; },
          async signOut() { session = null; save(); setTimeout(() => emit('SIGNED_OUT'), 0); return { error: null }; },
        },
      };
    },
  };
})();
