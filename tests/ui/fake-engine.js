// Engine giả cho kiểm thử: dùng data.js trong repo, đổi sang "hôm nay" (giờ VN), không gọi mạng.
(async () => {
  const fs = await import('node:fs');
  const g = {}; new Function('window', fs.readFileSync(process.cwd() + '/data.js', 'utf8'))(g);
  const D = g.DATA;
  const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  window.__result = { asof: today, gen: new Date().toISOString(), src: 'fake', vni: D.vni, bt: D.bt,
    st: { k: D.k, r: D.r }, ch: Object.fromEntries(Object.entries(D.ch).map(([s, c]) => [s, [c, []]])) };
  return { n: D.r.length };
})()
