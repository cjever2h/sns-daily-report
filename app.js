// SNS 데일리 리포트 (스레드) - 정적 SPA
// 데이터: 크롬 확장 프로그램이 매일 수집해 Supabase(sns_*)에 저장 → 이 앱은 읽기/분석 + 추적 계정 관리
import { SUPABASE_URL, SUPABASE_ANON_KEY, EXT_ZIP } from './config.js';
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $app = document.getElementById('app');
const KST = 9 * 3600e3;
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

const S = { user: null, settings: null, daily: [], posts: [], tracked: [], tdaily: [], tab: 'report', reportDay: null,
  postQ: '', postSort: 'recent', postRange: '30', anaRange: '30', folPeriod: 'day', loaded: false };

/* ---------- utils ---------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => n == null || Number.isNaN(n) ? '-' : Math.round(n).toLocaleString('ko-KR');
const fmt1 = n => n == null || !Number.isFinite(n) ? '-' : (Math.round(n * 10) / 10).toLocaleString('ko-KR');
const sign = n => n == null ? '-' : (n > 0 ? '+' : '') + fmt(n);
const cls = n => n > 0 ? 'up' : n < 0 ? 'down' : '';
const kdate = ms => new Date(ms + KST).toISOString().slice(0, 10);
const todayK = () => kdate(Date.now());
const shiftDay = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const postK = p => new Date(Date.parse(p.posted_at) + KST); // UTC 메서드로 KST 값을 읽음
const postDay = p => postK(p).toISOString().slice(0, 10);
const hm = p => postK(p).toISOString().slice(11, 16);
const dayLabel = d => { const x = new Date(d + 'T00:00:00Z'); return `${x.getUTCMonth() + 1}월 ${x.getUTCDate()}일(${DOW[x.getUTCDay()]})`; };
const conv = (f, v) => v ? (f || 0) / v * 1e4 : null; // 1만 조회당 팔로우
const sum = (a, k) => a.reduce((s, x) => s + (x[k] || 0), 0);
const avg = (a, k) => { const v = a.map(x => x[k]).filter(x => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const median = (a, k) => { const v = a.map(x => x[k]).filter(x => x != null).sort((x, y) => x - y); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const firstLine = t => (t || '').split('\n').find(x => x.trim()) || '(본문 없음)';
const threadUrl = p => `https://www.threads.com/@${p.handle || S.settings?.threads_handle || ''}/post/${p.code}`;
function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2200); }

/* ---------- charts (SVG) ---------- */
function lineChart(pts, { h = 200, color = '#ff7a1a', fill = true, yFmt = fmt } = {}) {
  if (pts.length < 2) return `<div class="empty">기록이 2일 이상 쌓이면 그래프가 나타나요.</div>`;
  const W = 640, H = h, L = 46, R = 10, T = 12, B = 24;
  const ys = pts.map(p => p.y); let mn = Math.min(...ys), mx = Math.max(...ys);
  if (mn === mx) { mn -= 1; mx += 1; } const pad = (mx - mn) * 0.12; mn -= pad; mx += pad;
  const x = i => L + (W - L - R) * (i / (pts.length - 1));
  const y = v => T + (H - T - B) * (1 - (v - mn) / (mx - mn));
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join('');
  const area = fill ? `<path d="${d}L${x(pts.length - 1)},${H - B}L${L},${H - B}Z" fill="${color}" opacity=".12"/>` : '';
  const ticks = [mn + pad, (mn + mx) / 2, mx - pad].map(v => `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${yFmt(v)}</text><line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#eee"/>`).join('');
  const step = Math.max(1, Math.ceil(pts.length / 6));
  const xl = pts.map((p, i) => (i % step === 0 || i === pts.length - 1) ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${esc(p.x)}</text>` : '').join('');
  const dots = pts.length <= 40 ? pts.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.y)}" r="2.5" fill="${color}"><title>${esc(p.x)} · ${yFmt(p.y)}</title></circle>`).join('') : '';
  return `<svg class="chart" viewBox="0 0 ${W} ${H}">${ticks}${area}<path d="${d}" fill="none" stroke="${color}" stroke-width="2.2"/>${dots}${xl}</svg>`;
}
function barChart(pts, { h = 190, color = '#ff7a1a', neg = '#cf222e', yFmt = fmt, hi = [] } = {}) {
  if (!pts.length) return `<div class="empty">데이터가 없어요.</div>`;
  const W = 640, H = h, L = 46, R = 8, T = 12, B = 24;
  const ys = pts.map(p => p.y || 0); const mx = Math.max(0, ...ys), mn = Math.min(0, ...ys); const rng = (mx - mn) || 1;
  const bw = (W - L - R) / pts.length;
  const y = v => T + (H - T - B) * (1 - (v - mn) / rng);
  const bars = pts.map((p, i) => { const v = p.y || 0; const y0 = y(0), y1 = y(v); const c = v < 0 ? neg : (hi.includes(i) ? '#b44d00' : color);
    return `<rect x="${(L + i * bw + bw * 0.15).toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${Math.max(1, Math.abs(y1 - y0)).toFixed(1)}" rx="2" fill="${c}"><title>${esc(p.x)} · ${yFmt(v)}${p.n != null ? ' · 글 ' + p.n + '개' : ''}</title></rect>`; }).join('');
  const step = Math.max(1, Math.ceil(pts.length / 12));
  const xl = pts.map((p, i) => i % step === 0 ? `<text x="${L + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(p.x)}</text>` : '').join('');
  const ticks = [mx, mn < 0 ? 0 : mx / 2].map(v => `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${yFmt(v)}</text><line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#eee"/>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}">${ticks}<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="#ccc"/>${bars}${xl}</svg>`;
}
function spark(vals) {
  const v = vals.filter(x => x != null); if (v.length < 2) return '';
  const mn = Math.min(...v), mx = Math.max(...v), r = (mx - mn) || 1;
  const d = v.map((y, i) => `${i ? 'L' : 'M'}${(i / (v.length - 1) * 118 + 1).toFixed(1)},${(32 - (y - mn) / r * 30).toFixed(1)}`).join('');
  return `<svg class="spark" viewBox="0 0 120 34"><path d="${d}" fill="none" stroke="#ff7a1a" stroke-width="2"/></svg>`;
}

/* ---------- data ---------- */
async function loadAll() {
  const uid = S.user.id;
  let { data: st } = await sb.from('sns_settings').select('*').eq('user_id', uid).maybeSingle();
  if (!st) { const r = await sb.from('sns_settings').insert({ user_id: uid }).select().single(); st = r.data; }
  S.settings = st;
  const [d, p, t, td] = await Promise.all([
    sb.from('sns_account_daily').select('*').order('day', { ascending: true }).limit(2000),
    sb.from('sns_posts').select('*').order('posted_at', { ascending: false }).limit(5000),
    sb.from('sns_tracked').select('*').order('created_at', { ascending: true }),
    sb.from('sns_tracked_daily').select('handle,day,followers,full_name,recent_posts').gte('day', shiftDay(todayK(), -180)).order('day', { ascending: true }).limit(10000),
  ]);
  S.daily = d.data || []; S.posts = (p.data || []).filter(x => x.posted_at); S.tracked = t.data || []; S.tdaily = td.data || [];
  S.loaded = true;
}
const fol = r => r.followers ?? r.insights_followers;
function followerOn(day) { // 해당 날짜 이전(포함) 가장 최근 기록
  let best = null; for (const r of S.daily) { if (r.day <= day && fol(r) != null) best = r; } return best;
}
const postsOn = day => S.posts.filter(p => postDay(p) === day).sort((a, b) => a.posted_at.localeCompare(b.posted_at));
const postsSince = days => { if (days === 'all') return S.posts; const cut = Date.now() - Number(days) * 864e5; return S.posts.filter(p => Date.parse(p.posted_at) >= cut); };

/* ---------- shell ---------- */
const TABS = [['report', '리포트'], ['followers', '팔로워'], ['posts', '내 글'], ['analysis', '분석'], ['track', '추적'], ['settings', '설정']];
function shell(inner) {
  const last = S.settings?.last_ingest_at ? new Date(Date.parse(S.settings.last_ingest_at) + KST).toISOString().slice(5, 16).replace('T', ' ') : '없음';
  return `<header class="top"><div class="top-in">
    <div class="brand"><h1>SNS 데일리 리포트 <span>· Threads</span></h1>
    <div class="meta">${S.settings?.threads_handle ? '@' + esc(S.settings.threads_handle) + '<br>' : ''}마지막 수집 ${last}</div></div>
    <nav class="tabs">${TABS.map(([k, l]) => `<button data-tab="${k}" class="${S.tab === k ? 'on' : ''}">${l}</button>`).join('')}</nav>
  </div></header><main>${inner}</main>`;
}
function render() {
  if (!S.user) return renderLogin();
  if (!S.loaded) { $app.innerHTML = `<div class="boot">데이터 불러오는 중…</div>`; return; }
  const views = { report: vReport, followers: vFollowers, posts: vPosts, analysis: vAnalysis, track: vTrack, settings: vSettings };
  const needData = !S.daily.length && !S.posts.length && !['settings', 'track'].includes(S.tab);
  $app.innerHTML = shell(needData ? vOnboard() : views[S.tab]());
}
function go(tab) { S.tab = tab; history.replaceState(null, '', '#' + tab); render(); window.scrollTo(0, 0); }

/* ---------- login ---------- */
function renderLogin(msg = '') {
  $app.innerHTML = `<div class="login card">
    <h2>SNS 데일리 리포트</h2>
    <p class="hint">런닝 캘린더 · PDS 플래너와 같은 계정으로 로그인하세요.</p>
    <form id="loginForm">
      <input id="em" type="email" placeholder="이메일" autocomplete="username" required>
      <input id="pw" type="password" placeholder="비밀번호" autocomplete="current-password" required>
      <button class="btn primary" type="submit">로그인</button>
    </form>
    <p class="hint" style="color:var(--bad)">${esc(msg)}</p></div>`;
  document.getElementById('loginForm').onsubmit = async e => {
    e.preventDefault();
    const { error } = await sb.auth.signInWithPassword({ email: document.getElementById('em').value.trim(), password: document.getElementById('pw').value });
    if (error) renderLogin('로그인 실패: ' + error.message);
  };
}

/* ---------- onboarding ---------- */
function vOnboard() {
  return `<div class="card"><h2>아직 수집된 데이터가 없어요</h2>
  <p>메타가 스레드 API 연동을 막아서, 이 앱은 <b>내 브라우저의 확장 프로그램</b>이 로그인된 스레드 화면을 읽어 매일 기록합니다. 아래 3단계만 하면 됩니다.</p>
  ${installGuide()}
  <div class="toolbar"><button class="btn dark" data-tab="settings">설정으로 이동</button></div></div>`;
}
function installGuide() {
  return `<ol class="steps">
    <li><a class="btn sm primary" href="${EXT_ZIP}" download>확장 프로그램 다운로드 (zip)</a> 받은 뒤 압축을 풉니다.</li>
    <li>크롬 주소창에 <code>chrome://extensions</code> 입력 → 오른쪽 위 <b>개발자 모드</b> 켜기 → <b>압축해제된 확장 프로그램을 로드합니다</b> → 푼 폴더 선택.</li>
    <li>확장 프로그램 아이콘(퍼즐 모양에서 고정) → 아래 <b>수집 키</b> 붙여넣고 저장 → <b>지금 수집하기</b>. 처음 한 번은 <b>과거 글 가져오기</b>도 눌러 주세요.</li>
    <li>그 브라우저에서 threads.com 에 로그인되어 있어야 합니다. 이후 매일 정한 시각(기본 07:00)에 자동 수집됩니다.</li>
  </ol>`;
}

/* ---------- report ---------- */
function vReport() {
  const day = S.reportDay || shiftDay(todayK(), -1);
  const ps = postsOn(day);
  const views = sum(ps, 'views'), follows = sum(ps, 'follows'), pv = sum(ps, 'profile_visits');
  const fNow = followerOn(todayK()), fDay = followerOn(day), fPrev = followerOn(shiftDay(day, -1)), f7 = followerOn(shiftDay(day, -7));
  const dayDelta = fDay && fPrev && fDay.day !== fPrev.day ? fol(fDay) - fol(fPrev) : null;
  const wkDelta = fDay && f7 && fDay.day !== f7.day ? fol(fDay) - fol(f7) : null;
  const p30 = postsSince(30).filter(p => postDay(p) < todayK());
  const conv30 = conv(sum(p30, 'follows'), sum(p30, 'views'));
  const cDay = conv(follows, views);
  const med30 = median(p30, 'views');
  const latest = S.daily[S.daily.length - 1];
  const best = [...ps].sort((a, b) => (b.follows || 0) - (a.follows || 0) || (b.views || 0) - (a.views || 0))[0];
  const act = suggestAction(day, ps, p30, conv30);

  const rows = ps.map(p => { const c = conv(p.follows, p.views); return `<tr>
    <td>${hm(p)}</td><td class="t">${esc(firstLine(p.text)).slice(0, 60)}</td><td>${fmt(p.views)}</td><td>${fmt(p.profile_visits)}</td><td>${fmt(p.follows)}</td>
    <td class="${c != null && conv30 != null && c >= conv30 ? 'up' : ''}">${fmt1(c)}</td><td>${fmt(p.likes)}</td><td>${fmt(p.replies)}</td>
    <td><a class="btn sm" href="${threadUrl(p)}" target="_blank" rel="noopener">보기</a></td></tr>`; }).join('');

  return `<div class="toolbar">
      <button class="btn" data-day="-1">◀ 전날</button>
      <input type="date" id="repDay" value="${day}" max="${todayK()}">
      <button class="btn" data-day="1" ${day >= todayK() ? 'disabled' : ''}>다음날 ▶</button>
      <button class="btn dark" id="copyRep">리포트 텍스트 복사</button>
    </div>
    <div class="card" style="background:#fffaf5"><h2>${dayLabel(day)} 스레드 리포트 <span class="hint">게시 ${ps.length}개 · 수치는 마지막 수집 기준</span></h2>
    <div class="kpis">
      <div class="kpi"><div class="l">팔로워 (현재)</div><div class="v">${fmt(fNow && fol(fNow))}</div><div class="d"><span class="${cls(dayDelta)}">그날 ${sign(dayDelta)}</span> · <span class="${cls(wkDelta)}">7일 ${sign(wkDelta)}</span></div></div>
      <div class="kpi"><div class="l">그날 글 조회수 합</div><div class="v">${fmt(views)}</div><div class="d muted">30일 글 중앙값 ${fmt(med30)}/글</div></div>
      <div class="kpi"><div class="l">글로 생긴 팔로우</div><div class="v">${fmt(follows)}</div><div class="d muted">프로필 방문 ${fmt(pv)}</div></div>
      <div class="kpi"><div class="l">1만 조회당 팔로우</div><div class="v ${cDay != null && conv30 != null ? (cDay >= conv30 ? 'up' : 'down') : ''}">${fmt1(cDay)}</div><div class="d muted">30일 평균 ${fmt1(conv30)} · 목표 30</div></div>
      <div class="kpi"><div class="l">최근 7일 조회 (인사이트)</div><div class="v">${fmt(latest?.views_7d)}</div><div class="d"><span class="${cls(latest?.net_followers_7d)}">순 팔로워 ${sign(latest?.net_followers_7d)}</span></div></div>
    </div></div>
    <div class="action"><div class="l">오늘의 행동 1개 (데이터 규칙 기반 제안)</div><div class="v">${esc(act.title)}</div><div class="s">${esc(act.why)}</div></div>
    ${best ? `<div class="card"><h2>그날 베스트 글 <span class="badge">팔로우 ${fmt(best.follows)}</span></h2>${postCard(best, conv30)}</div>` : ''}
    <div class="card"><h2>그날 올린 글</h2>${ps.length ? `<div class="scroll-x"><table>
      <tr><th>시각</th><th class="t">첫 줄</th><th>조회</th><th>프로필</th><th>팔로우</th><th>1만당</th><th>좋아요</th><th>답글</th><th></th></tr>${rows}</table></div>
      <p class="hint">좋아요·답글 수는 인사이트 비율로 계산한 값이라 1~2 차이가 날 수 있어요.</p>`
      : `<div class="empty">이 날짜에 수집된 글이 없어요. (인사이트는 하루 정도 늦게 반영돼요)</div>`}</div>`;
}
function suggestAction(day, ps, p30, conv30) {
  const scored = p30.filter(p => (p.views || 0) >= 300).map(p => ({ p, c: conv(p.follows, p.views) })).sort((a, b) => b.c - a.c);
  const top = scored[0];
  if (!ps.length) return top
    ? { title: `오늘 글 1개는 꼭: 30일 전환 1위 형식 다시 쓰기 → "${firstLine(top.p.text).slice(0, 40)}"`, why: `이 글은 1만 조회당 팔로우 ${fmt1(top.c)}명(30일 평균 ${fmt1(conv30)}). 같은 구조로 주제만 바꿔 보세요.` }
    : { title: '오늘 글 1개 올리고 내일 리포트로 확인하기', why: '비교할 데이터가 아직 부족해요. 매일 기록이 쌓이면 제안이 구체적으로 바뀝니다.' };
  const views = sum(ps, 'views'), c = conv(sum(ps, 'follows'), views);
  const bestDay = [...ps].sort((a, b) => (conv(b.follows, b.views) || 0) - (conv(a.follows, a.views) || 0))[0];
  if (c != null && conv30 != null && c < conv30 * 0.7 && top)
    return { title: `전환이 평균보다 낮았어요. 오늘은 "${firstLine(top.p.text).slice(0, 30)}" 형식으로 1개`, why: `그날 1만 조회당 ${fmt1(c)}명 vs 30일 평균 ${fmt1(conv30)}명. 30일 전환 1위 글(1만당 ${fmt1(top.c)}명)의 마지막 줄(질문/요청)을 그대로 가져가 보세요.` };
  if (bestDay && (bestDay.follows || 0) > 0)
    return { title: `그날 1위 "${firstLine(bestDay.text).slice(0, 30)}" 이어쓰기 1개`, why: `조회 ${fmt(bestDay.views)}, 팔로우 ${fmt(bestDay.follows)} (1만당 ${fmt1(conv(bestDay.follows, bestDay.views))}). 반응이 식기 전 같은 주제 후속 글이나 셀프 답글을 추가해 보세요.` };
  return { title: '마지막 줄에 팔로우 이유 한 줄 붙이기', why: `그날 글에서 팔로우가 나오지 않았어요. 30일 평균은 1만당 ${fmt1(conv30)}명. 글 끝에 "왜 팔로우해야 하는지" 한 줄을 넣어 비교해 보세요.` };
}
function reportText(day) {
  const ps = postsOn(day); const v = sum(ps, 'views'), f = sum(ps, 'follows');
  const fn = followerOn(todayK()); const p30 = postsSince(30).filter(p => postDay(p) < todayK());
  const act = suggestAction(day, ps, p30, conv(sum(p30, 'follows'), sum(p30, 'views')));
  const lines = [`[${dayLabel(day)} 스레드 리포트]`, `팔로워 ${fmt(fn && fol(fn))}`, `게시 ${ps.length}개 · 조회 ${fmt(v)} · 팔로우 ${fmt(f)} · 1만당 ${fmt1(conv(f, v))}`];
  ps.forEach(p => lines.push(`- ${hm(p)} ${firstLine(p.text).slice(0, 30)} | ${fmt(p.views)}뷰 / 팔로우 ${fmt(p.follows)}`));
  lines.push(`오늘의 행동: ${act.title}`);
  return lines.join('\n');
}
function postCard(p, conv30) {
  const c = conv(p.follows, p.views);
  return `<div class="post" data-code="${esc(p.code)}"><div class="when">${postDay(p)} ${hm(p)} (${DOW[postK(p).getUTCDay()]})
      <a class="btn sm" href="${threadUrl(p)}" target="_blank" rel="noopener">스레드에서 보기</a>
      <button class="btn sm" data-toggle>전체 보기</button></div>
    <div class="txt">${esc(p.text || '')}</div>
    <div class="chips"><span class="chip">조회 <b>${fmt(p.views)}</b></span><span class="chip">팔로우 <b>${fmt(p.follows)}</b></span>
      <span class="chip ${c != null && conv30 != null && c >= conv30 && p.views >= 300 ? 'hot' : ''}">1만당 <b>${fmt1(c)}</b></span>
      <span class="chip">프로필 <b>${fmt(p.profile_visits)}</b></span><span class="chip">♥ <b>${fmt(p.likes)}</b></span><span class="chip">답글 <b>${fmt(p.replies)}</b></span>
      <span class="chip">리포스트 <b>${fmt(p.reposts)}</b></span></div></div>`;
}

/* ---------- followers ---------- */
function vFollowers() {
  const rows = S.daily.filter(r => fol(r) != null);
  if (!rows.length) return `<div class="card empty">팔로워 기록이 아직 없어요.</div>`;
  const last = rows[rows.length - 1];
  const at = d => { let b = null; for (const r of rows) if (r.day <= d) b = r; return b; };
  const dlt = n => { const a = at(shiftDay(last.day, -n)); return a && a.day !== last.day ? fol(last) - fol(a) : null; };
  // 기간 집계
  const key = { day: r => r.day, week: r => { const x = new Date(r.day + 'T00:00:00Z'); const dw = (x.getUTCDay() + 6) % 7; return shiftDay(r.day, -dw); }, month: r => r.day.slice(0, 7) }[S.folPeriod];
  const groups = new Map(); for (const r of rows) groups.set(key(r), r); // 각 기간의 마지막 기록
  const g = [...groups.entries()];
  const changes = g.map(([k, r], i) => ({ x: S.folPeriod === 'month' ? k.slice(2).replace('-', '.') : k.slice(5).replace('-', '/'), y: i ? fol(r) - fol(g[i - 1][1]) : null, f: fol(r), k })).slice(1);
  const line = rows.slice(-120).map(r => ({ x: r.day.slice(5).replace('-', '/'), y: fol(r) }));
  const tbl = [...changes].reverse().slice(0, 60).map(c => `<tr><td>${c.k}${S.folPeriod === 'week' ? ' 주' : ''}</td><td>${fmt(c.f)}</td><td class="${cls(c.y)}">${sign(c.y)}</td></tr>`).join('');
  return `<div class="kpis" style="margin-bottom:14px">
      <div class="kpi"><div class="l">현재 팔로워</div><div class="v">${fmt(fol(last))}</div><div class="d muted">${last.day} 기록</div></div>
      <div class="kpi"><div class="l">하루</div><div class="v ${cls(dlt(1))}">${sign(dlt(1))}</div></div>
      <div class="kpi"><div class="l">7일</div><div class="v ${cls(dlt(7))}">${sign(dlt(7))}</div></div>
      <div class="kpi"><div class="l">30일</div><div class="v ${cls(dlt(30))}">${sign(dlt(30))}</div></div>
      <div class="kpi"><div class="l">인사이트 순 팔로워 (7일/30일)</div><div class="v">${sign(last.net_followers_7d)}</div><div class="d muted">30일 ${sign(last.net_followers_30d)}</div></div>
    </div>
    <div class="card"><h2>팔로워 추이</h2>${lineChart(line)}</div>
    <div class="card"><h2>변화량 <span class="seg">${[['day', '일'], ['week', '주'], ['month', '월']].map(([k, l]) => `<button data-fp="${k}" class="${S.folPeriod === k ? 'on' : ''}">${l}</button>`).join('')}</span></h2>
      ${barChart(changes.slice(-40))}
      <div class="scroll-x"><table><tr><th>기간</th><th>팔로워</th><th>변화</th></tr>${tbl}</table></div>
      <p class="hint">팔로워 수는 수집한 날의 프로필 숫자예요. 수집을 거른 날은 다음 기록에 합쳐져요.</p></div>`;
}

/* ---------- posts ---------- */
const SORTS = { recent: ['최신순', (a, b) => b.posted_at.localeCompare(a.posted_at)], views: ['조회순', (a, b) => (b.views || 0) - (a.views || 0)],
  follows: ['팔로우순', (a, b) => (b.follows || 0) - (a.follows || 0)], conv: ['전환율순(조회 300+)', (a, b) => (conv(b.follows, b.views) || 0) - (conv(a.follows, a.views) || 0)],
  likes: ['좋아요순', (a, b) => (b.likes || 0) - (a.likes || 0)], replies: ['답글순', (a, b) => (b.replies || 0) - (a.replies || 0)], visits: ['프로필 방문순', (a, b) => (b.profile_visits || 0) - (a.profile_visits || 0)] };
function vPosts() {
  let ps = postsSince(S.postRange);
  const q = S.postQ.trim().toLowerCase();
  if (q) ps = ps.filter(p => (p.text || '').toLowerCase().includes(q));
  if (S.postSort === 'conv') ps = ps.filter(p => (p.views || 0) >= 300);
  ps = [...ps].sort(SORTS[S.postSort][1]);
  const p30 = postsSince(30); const conv30 = conv(sum(p30, 'follows'), sum(p30, 'views'));
  const shown = ps.slice(0, 200);
  return `<div class="toolbar">
      <input type="search" id="postQ" placeholder="글 내용 검색" value="${esc(S.postQ)}">
      <select id="postSort">${Object.entries(SORTS).map(([k, [l]]) => `<option value="${k}" ${S.postSort === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select id="postRange">${[['7', '7일'], ['30', '30일'], ['90', '90일'], ['all', '전체']].map(([k, l]) => `<option value="${k}" ${S.postRange === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div>
    <div class="card"><h2>내 글 <span class="hint">${fmt(ps.length)}개 · 조회 합 ${fmt(sum(ps, 'views'))} · 팔로우 합 ${fmt(sum(ps, 'follows'))}</span></h2>
    ${shown.length ? shown.map(p => postCard(p, conv30)).join('') : `<div class="empty">조건에 맞는 글이 없어요.</div>`}
    ${ps.length > 200 ? `<p class="hint">상위 200개만 표시했어요. 검색이나 기간으로 좁혀 보세요.</p>` : ''}</div>`;
}

/* ---------- analysis ---------- */
function vAnalysis() {
  const ps = postsSince(S.anaRange).filter(p => p.views != null);
  if (!ps.length) return `<div class="card empty">분석할 글이 없어요.</div>`;
  const tot = { v: sum(ps, 'views'), f: sum(ps, 'follows') };
  const c0 = conv(tot.f, tot.v);
  const top = (fn, n = 5) => [...ps].sort(fn).slice(0, n);
  const mini = (p, val) => `<tr><td class="t">${esc(firstLine(p.text)).slice(0, 44)}<div class="hint">${postDay(p)} ${hm(p)}</div></td><td>${val}</td><td><a class="btn sm" href="${threadUrl(p)}" target="_blank" rel="noopener">보기</a></td></tr>`;
  // 시간대
  const hours = Array.from({ length: 24 }, (_, h) => { const a = ps.filter(p => postK(p).getUTCHours() === h); return { x: h + '시', n: a.length, y: a.length ? sum(a, 'views') / a.length : 0, c: conv(sum(a, 'follows'), sum(a, 'views')) }; });
  const hRank = hours.map((h, i) => ({ i, y: h.n >= 2 ? h.y : -1 })).sort((a, b) => b.y - a.y).slice(0, 3).filter(x => x.y > 0).map(x => x.i);
  const days = Array.from({ length: 7 }, (_, d) => { const a = ps.filter(p => postK(p).getUTCDay() === d); return { x: DOW[d], n: a.length, y: a.length ? sum(a, 'views') / a.length : 0, c: conv(sum(a, 'follows'), sum(a, 'views')) }; });
  // 형식
  const feats = [
    ['질문으로 끝남', p => /[?？]\s*[^\n]{0,6}$/.test((p.text || '').trim())],
    ['번호 목록(1. 2.)', p => /(^|\n)\s*[1-9][.)]\s/.test(p.text || '')],
    ['팔로우/스친 요청', p => /팔로우|스친|친해지/.test(p.text || '')],
    ['아침 인사', p => /좋은 아침|굿모닝|굿모닝/.test(p.text || '')],
    ['짧은 글(80자 미만)', p => (p.text || '').length < 80],
    ['긴 글(250자 이상)', p => (p.text || '').length >= 250],
  ].map(([l, f]) => { const a = ps.filter(f), b = ps.filter(p => !f(p)); return { l, n: a.length, v: a.length ? sum(a, 'views') / a.length : null, c: conv(sum(a, 'follows'), sum(a, 'views')), cb: conv(sum(b, 'follows'), sum(b, 'views')) }; });
  const fRows = feats.map(f => `<tr><td>${f.l}</td><td>${f.n}</td><td>${fmt(f.v)}</td><td class="${f.c != null && f.cb != null ? (f.c > f.cb ? 'up' : 'down') : ''}">${fmt1(f.c)}</td><td class="muted">${fmt1(f.cb)}</td></tr>`).join('');
  const hTbl = hours.filter(h => h.n).map(h => `<tr><td>${h.x}</td><td>${h.n}</td><td>${fmt(h.y)}</td><td>${fmt1(h.c)}</td></tr>`).join('');
  return `<div class="toolbar"><span class="seg">${[['7', '7일'], ['30', '30일'], ['90', '90일'], ['all', '전체']].map(([k, l]) => `<button data-ar="${k}" class="${S.anaRange === k ? 'on' : ''}">${l}</button>`).join('')}</span>
      <span class="hint">글 ${ps.length}개 기준</span></div>
    <div class="kpis" style="margin-bottom:14px">
      <div class="kpi"><div class="l">글당 평균 조회</div><div class="v">${fmt(avg(ps, 'views'))}</div><div class="d muted">중앙값 ${fmt(median(ps, 'views'))}</div></div>
      <div class="kpi"><div class="l">글당 평균 팔로우</div><div class="v">${fmt1(avg(ps, 'follows'))}</div><div class="d muted">합 ${fmt(tot.f)}</div></div>
      <div class="kpi"><div class="l">1만 조회당 팔로우</div><div class="v">${fmt1(c0)}</div><div class="d muted">목표 30</div></div>
      <div class="kpi"><div class="l">글당 좋아요 / 답글</div><div class="v">${fmt(avg(ps, 'likes'))} / ${fmt(avg(ps, 'replies'))}</div><div class="d muted">리포스트 ${fmt1(avg(ps, 'reposts'))}</div></div>
      <div class="kpi"><div class="l">글당 프로필 방문</div><div class="v">${fmt(avg(ps, 'profile_visits'))}</div><div class="d muted">방문→팔로우 ${fmt1(sum(ps, 'profile_visits') ? tot.f / sum(ps, 'profile_visits') * 100 : null)}%</div></div>
    </div>
    <div class="grid2">
      <div class="card"><h2>조회 TOP 5</h2><table>${top((a, b) => b.views - a.views).map(p => mini(p, fmt(p.views))).join('')}</table></div>
      <div class="card"><h2>팔로우 TOP 5</h2><table>${top((a, b) => (b.follows || 0) - (a.follows || 0)).map(p => mini(p, fmt(p.follows))).join('')}</table></div>
      <div class="card"><h2>전환율 TOP 5 <span class="hint">조회 300+ · 1만당 팔로우</span></h2><table>${[...ps].filter(p => p.views >= 300).sort((a, b) => conv(b.follows, b.views) - conv(a.follows, a.views)).slice(0, 5).map(p => mini(p, fmt1(conv(p.follows, p.views)))).join('') || '<tr><td class="muted">조회 300 넘는 글이 없어요</td></tr>'}</table></div>
      <div class="card"><h2>답글 TOP 5</h2><table>${top((a, b) => (b.replies || 0) - (a.replies || 0)).map(p => mini(p, fmt(p.replies))).join('')}</table></div>
    </div>
    <div class="card" style="margin-top:14px"><h2>시간대 인사이트 <span class="hint">올린 시각별 글당 평균 조회 (진한 막대 = 글 2개 이상 중 상위 3)</span></h2>
      ${barChart(hours, { hi: hRank })}
      <div class="scroll-x"><table><tr><th>시각</th><th>글</th><th>평균 조회</th><th>1만당 팔로우</th></tr>${hTbl}</table></div></div>
    <div class="grid2">
      <div class="card"><h2>요일별 평균 조회</h2>${barChart(days)}
        <table><tr><th>요일</th><th>글</th><th>평균 조회</th><th>1만당 팔로우</th></tr>${days.map(d => `<tr><td>${d.x}</td><td>${d.n}</td><td>${fmt(d.y)}</td><td>${fmt1(d.c)}</td></tr>`).join('')}</table></div>
      <div class="card"><h2>글 형식별 비교</h2><table><tr><th>형식</th><th>글</th><th>평균 조회</th><th>1만당</th><th>나머지</th></tr>${fRows}</table>
        <p class="hint">'나머지'는 그 형식이 아닌 글들의 1만당 팔로우. 글 수가 적으면 우연일 수 있어요(가설로 보기).</p></div>
    </div>`;
}

/* ---------- track ---------- */
function vTrack() {
  const by = new Map(); for (const r of S.tdaily) { if (!by.has(r.handle)) by.set(r.handle, []); by.get(r.handle).push(r); }
  const me = S.settings?.threads_handle;
  const at = (arr, d) => { let b = null; for (const r of arr) if (r.day <= d) b = r; return b; };
  const row = (h, arr, note, isMe) => {
    const last = arr[arr.length - 1];
    const dl = n => { if (!last) return null; const a = at(arr, shiftDay(last.day, -n)); return a && a.day !== last.day ? last.followers - a.followers : null; };
    const rp = last?.recent_posts || [];
    const avgLike = rp.length ? sum(rp, 'likes') / rp.length : null;
    return `<div class="track-row"><div><div class="name">${esc(last?.full_name || h)} ${isMe ? '<span class="badge">나</span>' : ''}</div>
        <div class="sub">@${esc(h)}${note ? ' · ' + esc(note) : ''}${last ? ' · ' + last.day + ' 기록' : ' · 다음 수집 때 기록돼요'}${avgLike != null ? ` · 최근 글 평균 ♥ ${fmt(avgLike)}` : ''}</div></div>
      <div class="nums">${spark(arr.slice(-30).map(r => r.followers))}<div class="big">${fmt(last?.followers)}</div>
        <div class="hint">하루 <span class="${cls(dl(1))}">${sign(dl(1))}</span><br>7일 <span class="${cls(dl(7))}">${sign(dl(7))}</span> · 30일 <span class="${cls(dl(30))}">${sign(dl(30))}</span></div>
        <a class="btn sm" href="https://www.threads.com/@${esc(h)}" target="_blank" rel="noopener">프로필</a>
        ${isMe ? '' : `<button class="btn sm danger" data-del="${esc(h)}">삭제</button>`}</div></div>`;
  };
  const meArr = S.daily.filter(r => fol(r) != null).map(r => ({ day: r.day, followers: fol(r), full_name: '내 계정' }));
  return `<div class="card"><h2>추적할 계정 추가</h2>
      <form class="toolbar" id="addTrack" style="margin:0"><input type="text" id="th" placeholder="@아이디 또는 프로필 주소" required><input type="text" id="tn" placeholder="메모(선택)" style="flex:0 1 160px"><button class="btn primary">추가</button></form>
      <p class="hint">공개 계정의 팔로워 수와 최근 글 반응을 매일 기록합니다. 추가한 뒤 확장 프로그램이 다음에 수집할 때부터 쌓여요.</p></div>
    <div class="card"><h2>추적 중 (${S.tracked.length})</h2>
      ${me ? row(me, meArr, '', true) : ''}
      ${S.tracked.map(t => row(t.handle, by.get(t.handle) || [], t.note)).join('') || (me ? '' : '<div class="empty">아직 추적 중인 계정이 없어요.</div>')}
    </div>`;
}

/* ---------- settings ---------- */
function vSettings() {
  const st = S.settings || {};
  const last = st.last_ingest_at ? new Date(Date.parse(st.last_ingest_at) + KST).toISOString().slice(0, 16).replace('T', ' ') : '아직 없음';
  return `<div class="card"><h2>수집 키 <span class="hint">확장 프로그램이 내 데이터에 쓰는 비밀 키</span></h2>
      <div class="keybox" id="keyBox">${esc(st.ingest_key || '')}</div>
      <div class="toolbar" style="margin-top:8px"><button class="btn dark" id="copyKey">키 복사</button><button class="btn" id="regenKey">키 새로 만들기</button></div>
      <p class="hint">다른 사람에게 공유하지 마세요. 새로 만들면 기존 키는 바로 막히고, 확장 프로그램에 새 키를 다시 넣어야 해요.</p></div>
    <div class="card"><h2>확장 프로그램 설치</h2>${installGuide()}</div>
    <div class="card"><h2>수집 상태</h2>
      <p>마지막 수집: <b>${last}</b> (KST)<br><span class="hint">${esc(st.last_ingest_note || '')}</span></p>
      <p>스레드 계정: <b>${st.threads_handle ? '@' + esc(st.threads_handle) : '첫 수집 때 자동으로 채워져요'}</b></p>
      <p>기록: 팔로워 ${S.daily.length}일 · 글 ${S.posts.length}개 · 추적 ${S.tracked.length}계정</p>
      <div class="toolbar"><button class="btn" id="reload">새로고침</button></div></div>
    <div class="card"><h2>계정</h2><p>${esc(S.user.email || '')}</p>
      <div class="toolbar"><button class="btn" id="logout">로그아웃</button><button class="btn danger" id="wipe">수집 데이터 전체 삭제</button></div>
      <p class="hint" id="wipeMsg"></p></div>`;
}

/* ---------- events ---------- */
$app.addEventListener('click', async e => {
  const t = e.target.closest('button, a'); if (!t) return;
  if (t.dataset.tab) return go(t.dataset.tab);
  if (t.dataset.day) { const d = S.reportDay || shiftDay(todayK(), -1); S.reportDay = shiftDay(d, Number(t.dataset.day)); if (S.reportDay > todayK()) S.reportDay = todayK(); return render(); }
  if (t.dataset.fp) { S.folPeriod = t.dataset.fp; return render(); }
  if (t.dataset.ar) { S.anaRange = t.dataset.ar; return render(); }
  if (t.hasAttribute('data-toggle')) { const p = t.closest('.post'); p.classList.toggle('open'); t.textContent = p.classList.contains('open') ? '접기' : '전체 보기'; return; }
  if (t.dataset.del) {
    if (t.dataset.confirm !== '1') { t.dataset.confirm = '1'; t.textContent = '정말 삭제'; return; }
    await sb.from('sns_tracked').delete().eq('handle', t.dataset.del);
    await sb.from('sns_tracked_daily').delete().eq('handle', t.dataset.del);
    S.tracked = S.tracked.filter(x => x.handle !== t.dataset.del); S.tdaily = S.tdaily.filter(x => x.handle !== t.dataset.del);
    toast('삭제했어요'); return render();
  }
  switch (t.id) {
    case 'copyRep': await navigator.clipboard.writeText(reportText(S.reportDay || shiftDay(todayK(), -1))); return toast('리포트를 복사했어요');
    case 'copyKey': await navigator.clipboard.writeText(S.settings.ingest_key); return toast('수집 키를 복사했어요');
    case 'regenKey': {
      if (t.dataset.confirm !== '1') { t.dataset.confirm = '1'; t.textContent = '한 번 더 누르면 새 키'; return; }
      const nk = crypto.randomUUID();
      const { data, error } = await sb.from('sns_settings').update({ ingest_key: nk }).eq('user_id', S.user.id).select().single();
      if (error) return toast('실패: ' + error.message);
      S.settings = data; toast('새 키를 만들었어요. 확장 프로그램에 다시 넣어주세요'); return render();
    }
    case 'reload': S.loaded = false; render(); await loadAll(); return render();
    case 'logout': await sb.auth.signOut(); return;
    case 'wipe': {
      if (t.dataset.confirm !== '1') { t.dataset.confirm = '1'; t.textContent = '한 번 더 누르면 모두 삭제'; document.getElementById('wipeMsg').textContent = '팔로워 기록·글·추적 기록이 모두 지워집니다(수집 키는 유지).'; return; }
      for (const tb of ['sns_post_snapshots', 'sns_posts', 'sns_account_daily', 'sns_tracked_daily', 'sns_tracked']) await sb.from(tb).delete().eq('user_id', S.user.id);
      await loadAll(); toast('삭제했어요'); return render();
    }
  }
});
$app.addEventListener('input', e => {
  if (e.target.id === 'postQ') { S.postQ = e.target.value; clearTimeout(S._q); S._q = setTimeout(() => { const pos = e.target.selectionStart; render(); const el = document.getElementById('postQ'); el.focus(); el.setSelectionRange(pos, pos); }, 250); }
});
$app.addEventListener('change', e => {
  if (e.target.id === 'postSort') { S.postSort = e.target.value; render(); }
  if (e.target.id === 'postRange') { S.postRange = e.target.value; render(); }
  if (e.target.id === 'repDay' && e.target.value) { S.reportDay = e.target.value; render(); }
});
$app.addEventListener('submit', async e => {
  if (e.target.id !== 'addTrack') return;
  e.preventDefault();
  let h = document.getElementById('th').value.trim();
  const m = h.match(/threads\.(?:com|net)\/@([\w.]+)/i); if (m) h = m[1];
  h = h.replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9._]{1,40}$/.test(h)) return toast('아이디 형식이 맞지 않아요');
  if (S.tracked.some(x => x.handle === h)) return toast('이미 추적 중이에요');
  const { data, error } = await sb.from('sns_tracked').insert({ user_id: S.user.id, handle: h, note: document.getElementById('tn').value.trim() || null }).select().single();
  if (error) return toast('실패: ' + error.message);
  S.tracked.push(data); toast(`@${h} 추가. 다음 수집부터 기록돼요`); render();
});

/* ---------- boot ---------- */
const hashTab = location.hash.slice(1); if (TABS.some(([k]) => k === hashTab)) S.tab = hashTab;
async function onUser(u) {
  if (u?.id === S.user?.id && (S.loaded || S.loading)) return;
  S.user = u; S.loaded = false;
  if (!u) return render();
  S.loading = true; render();
  try { await loadAll(); } catch (err) { $app.innerHTML = `<div class="boot">불러오기 실패: ${esc(err.message)}</div>`; return; }
  finally { S.loading = false; }
  render();
}
// onAuthStateChange 안에서 바로 DB 호출을 기다리면 교착될 수 있어 다음 틱으로 미룹니다
sb.auth.onAuthStateChange((ev, session) => { setTimeout(() => onUser(session?.user || null), 0); });
