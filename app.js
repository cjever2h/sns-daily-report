// SNS 데일리 리포트 (스레드) - 정적 SPA
// 데이터: 크롬 확장 프로그램이 매일 수집해 Supabase(sns_*)에 저장 → 이 앱은 읽기/분석 + 추적 계정 관리
import { SUPABASE_URL, SUPABASE_ANON_KEY, EXT_ZIP } from './config.js';
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $app = document.getElementById('app');
const KST = 9 * 3600e3;
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

const S = { requests: [], reqForm: false, openReq: null, platform: localStorage.getItem('sns_pf') === 'instagram' ? 'instagram' : 'threads', allDaily: [], allPosts: [], signed: {}, user: null, settings: null, daily: [], posts: [], tracked: [], tdaily: [], drafts: [], reports: [], draftDay: null, edits: {}, showFull: false, tab: 'report', reportDay: null,
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
const IG = () => S.platform === 'instagram';
const PF = () => IG() ? 'Instagram' : 'Threads';
const KIND = { reel: '릴스', carousel: '캐러셀', image: '사진', text: '글' };
const threadUrl = p => (p.platform || 'threads') === 'instagram'
  ? `https://www.instagram.com/${p.media_kind === 'reel' ? 'reel' : 'p'}/${p.code}/`
  : `https://www.threads.com/@${p.handle || S.settings?.threads_handle || ''}/post/${p.code}`;
function applyPlatform() {
  const pf = r => (r.platform || 'threads') === S.platform;
  S.daily = S.allDaily.filter(pf); S.posts = S.allPosts.filter(pf);
}
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
  const [d, p, t, td, dr, rp] = await Promise.all([
    sb.from('sns_account_daily').select('*').order('day', { ascending: true }).limit(2000),
    sb.from('sns_posts').select('*').order('posted_at', { ascending: false }).limit(5000),
    sb.from('sns_tracked').select('*').order('created_at', { ascending: true }),
    sb.from('sns_tracked_daily').select('handle,day,followers,full_name,recent_posts').gte('day', shiftDay(todayK(), -180)).order('day', { ascending: true }).limit(10000),
    sb.from('sns_drafts').select('*').gte('report_day', shiftDay(todayK(), -14)).order('slot_at', { ascending: true }).limit(500),
    sb.from('sns_daily_reports').select('*').gte('day', shiftDay(todayK(), -30)).order('day', { ascending: false }).limit(60),
  ]);
  S.allDaily = d.data || []; S.allPosts = (p.data || []).filter(x => x.posted_at); S.tracked = t.data || []; S.tdaily = td.data || [];
  applyPlatform();
  S.drafts = dr.data || []; S.reports = rp.data || [];
  await loadRequests();
  S.loaded = true;
}
const fol = r => r.followers ?? r.insights_followers;
function followerOn(day) { // 해당 날짜 이전(포함) 가장 최근 기록
  let best = null; for (const r of S.daily) { if (r.day <= day && fol(r) != null) best = r; } return best;
}
const postsOn = day => S.posts.filter(p => postDay(p) === day).sort((a, b) => a.posted_at.localeCompare(b.posted_at));
const postsSince = days => { if (days === 'all') return S.posts; const cut = Date.now() - Number(days) * 864e5; return S.posts.filter(p => Date.parse(p.posted_at) >= cut); };

/* ---------- shell ---------- */
const TABS = [['report', '리포트'], ['drafts', '초안'], ['followers', '팔로워'], ['posts', '내 글'], ['analysis', '분석'], ['track', '추적'], ['settings', '설정']];
function shell(inner) {
  const last = S.settings?.last_ingest_at ? new Date(Date.parse(S.settings.last_ingest_at) + KST).toISOString().slice(5, 16).replace('T', ' ') : '없음';
  return `<header class="top"><div class="top-in">
    <div class="brand"><h1>SNS 데일리 리포트 <span>· ${PF()}</span></h1>
    <span class="seg pfseg"><button data-pf="threads" class="${IG() ? '' : 'on'}">스레드</button><button data-pf="instagram" class="${IG() ? 'on' : ''}">인스타</button></span>
    <div class="meta">${IG() ? '@' + esc(S.settings?.ig_handle || 'habbit_theone') + '<br>' + igLast() : (S.settings?.threads_handle ? '@' + esc(S.settings.threads_handle) + '<br>' : '') + '마지막 수집 ' + last}</div></div>
    <nav class="tabs">${TABS.map(([k, l]) => `<button data-tab="${k}" class="${S.tab === k ? 'on' : ''}">${l}</button>`).join('')}</nav>
  </div></header><main>${inner}</main>`;
}
function igLast() { const r = S.daily[S.daily.length - 1]; return r ? '마지막 수집 ' + new Date(Date.parse(r.collected_at) + KST).toISOString().slice(5, 16).replace('T', ' ') : '아직 수집 없음'; }
function render() {
  if (!S.user) return renderLogin();
  if (!S.loaded) { $app.innerHTML = `<div class="boot">데이터 불러오는 중…</div>`; return; }
  const views = { report: vReport, drafts: vDrafts, followers: vFollowers, posts: vPosts, analysis: vAnalysis, track: vTrack, settings: vSettings };
  const needData = !S.daily.length && !S.posts.length && !['settings', 'track', 'drafts'].includes(S.tab);
  pollRequests();
  $app.innerHTML = shell(needData ? (IG() ? `<div class="card empty">인스타 데이터는 매일 아침 Aside 리포트가 올려요. 내일 아침부터 표시돼요.</div>` : vOnboard()) : views[S.tab]());
  if (S.tab === 'drafts') loadThumbs();
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
    <td class="${c != null && conv30 != null && c >= conv30 ? 'up' : ''}">${fmt1(c)}</td><td>${fmt(p.likes)}</td><td>${fmt(p.replies)}</td>${IG() ? `<td>${fmt(p.saves)}</td><td>${fmt(p.shares)}</td><td>${fmt1(p.nonfollower_view_pct)}%</td>` : ''}
    <td><a class="btn sm" href="${threadUrl(p)}" target="_blank" rel="noopener">보기</a></td></tr>`; }).join('');

  return `${requestBar()}${aiReportCard()}<div class="toolbar">
      <button class="btn" data-day="-1">◀ 전날</button>
      <input type="date" id="repDay" value="${day}" max="${todayK()}">
      <button class="btn" data-day="1" ${day >= todayK() ? 'disabled' : ''}>다음날 ▶</button>
      <button class="btn dark" id="copyRep">리포트 텍스트 복사</button>
    </div>
    <div class="card" style="background:#fffaf5"><h2>${dayLabel(day)} ${IG() ? '인스타' : '스레드'} 리포트 <span class="hint">게시 ${ps.length}개 · 수치는 마지막 수집 기준</span></h2>
    <div class="kpis">
      <div class="kpi"><div class="l">팔로워 (현재)</div><div class="v">${fmt(fNow && fol(fNow))}</div><div class="d"><span class="${cls(dayDelta)}">그날 ${sign(dayDelta)}</span> · <span class="${cls(wkDelta)}">7일 ${sign(wkDelta)}</span></div></div>
      <div class="kpi"><div class="l">그날 글 조회수 합</div><div class="v">${fmt(views)}</div><div class="d muted">30일 글 중앙값 ${fmt(med30)}/글</div></div>
      <div class="kpi"><div class="l">글로 생긴 팔로우</div><div class="v">${fmt(follows)}</div><div class="d muted">프로필 방문 ${fmt(pv)}</div></div>
      <div class="kpi"><div class="l">1만 조회당 팔로우</div><div class="v ${cDay != null && conv30 != null ? (cDay >= conv30 ? 'up' : 'down') : ''}">${fmt1(cDay)}</div><div class="d muted">30일 평균 ${fmt1(conv30)} · 목표 30</div></div>
      <div class="kpi"><div class="l">최근 7일 조회 (인사이트)</div><div class="v">${fmt(latest?.views_7d)}</div><div class="d">${IG() ? `<span class="muted">비팔로워 ${fmt1(latest?.nonfollower_view_pct_7d)}% · 프로필 방문 ${fmt(latest?.profile_visits_7d)}</span>` : `<span class="${cls(latest?.net_followers_7d)}">순 팔로워 ${sign(latest?.net_followers_7d)}</span>`}</div></div>
    </div></div>
    <div class="action"><div class="l">오늘의 행동 1개 (데이터 규칙 기반 제안)</div><div class="v">${esc(act.title)}</div><div class="s">${esc(act.why)}</div></div>
    ${best ? `<div class="card"><h2>그날 베스트 글 <span class="badge">팔로우 ${fmt(best.follows)}</span></h2>${postCard(best, conv30)}</div>` : ''}
    <div class="card"><h2>그날 올린 글</h2>${ps.length ? `<div class="scroll-x"><table>
      <tr><th>시각</th><th class="t">첫 줄</th><th>조회</th><th>프로필</th><th>팔로우</th><th>1만당</th><th>좋아요</th><th>${IG() ? '댓글' : '답글'}</th>${IG() ? '<th>저장</th><th>공유</th><th>비팔로워</th>' : ''}<th></th></tr>${rows}</table></div>
      <p class="hint">${IG() ? '인스타 수치는 매일 아침 Aside가 인사이트에서 읽은 값이에요. 릴스는 올린 뒤 7일 동안 매일 다시 읽어요.' : '좋아요·답글 수는 인사이트 비율로 계산한 값이라 1~2 차이가 날 수 있어요.'}</p>`
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
  const lines = [`[${dayLabel(day)} ${IG() ? '인스타' : '스레드'} 리포트]`, `팔로워 ${fmt(fn && fol(fn))}`, `게시 ${ps.length}개 · 조회 ${fmt(v)} · 팔로우 ${fmt(f)} · 1만당 ${fmt1(conv(f, v))}`];
  ps.forEach(p => lines.push(`- ${hm(p)} ${firstLine(p.text).slice(0, 30)} | ${fmt(p.views)}뷰 / 팔로우 ${fmt(p.follows)}`));
  lines.push(`오늘의 행동: ${act.title}`);
  return lines.join('\n');
}
function postCard(p, conv30) {
  const c = conv(p.follows, p.views);
  const ig = (p.platform || 'threads') === 'instagram';
  return `<div class="post" data-code="${esc(p.code)}"><div class="when">${postDay(p)} ${hm(p)} (${DOW[postK(p).getUTCDay()]})${ig && p.media_kind ? ` <span class="chip">${KIND[p.media_kind] || esc(p.media_kind)}</span>` : ''}
      <a class="btn sm" href="${threadUrl(p)}" target="_blank" rel="noopener">${ig ? '인스타에서 보기' : '스레드에서 보기'}</a>
      <button class="btn sm" data-toggle>전체 보기</button></div>
    <div class="txt">${esc(p.text || '')}</div>
    <div class="chips"><span class="chip">조회 <b>${fmt(p.views)}</b></span><span class="chip">팔로우 <b>${fmt(p.follows)}</b></span>
      <span class="chip ${c != null && conv30 != null && c >= conv30 && p.views >= 300 ? 'hot' : ''}">1만당 <b>${fmt1(c)}</b></span>
      <span class="chip">프로필 <b>${fmt(p.profile_visits)}</b></span><span class="chip">♥ <b>${fmt(p.likes)}</b></span><span class="chip">${ig ? '댓글' : '답글'} <b>${fmt(p.replies)}</b></span>
      ${ig ? `<span class="chip">저장 <b>${fmt(p.saves)}</b></span><span class="chip">공유 <b>${fmt(p.shares)}</b></span><span class="chip ${p.nonfollower_view_pct >= 60 ? 'hot' : ''}">비팔로워 <b>${fmt1(p.nonfollower_view_pct)}%</b></span>` : `<span class="chip">리포스트 <b>${fmt(p.reposts)}</b></span>`}</div></div>`;
}

/* ---------- 지금 업데이트 / 리포트 요청 (Aside가 15분마다 처리) ---------- */
async function loadRequests() {
  const { data } = await sb.from('sns_requests').select('*').order('created_at', { ascending: false }).limit(20);
  const before = new Map(S.requests.map(r => [r.id, r.status]));
  S.requests = data || [];
  return S.requests.filter(r => before.get(r.id) && before.get(r.id) !== r.status && ['done', 'failed'].includes(r.status));
}
const RQ = { pending: '대기 중', running: '처리 중', done: '완료', failed: '실패', canceled: '취소됨' };
const SCOPE = { all: '전체(스레드·인스타·블로그)', threads: '스레드', instagram: '인스타', blog: '블로그' };
const RANGE = { today: '오늘', yesterday: '어제', '7d': '최근 7일' };
const kts = s => s ? new Date(Date.parse(s) + KST).toISOString().slice(5, 16).replace('T', ' ') : '-';
const active = kind => S.requests.find(r => r.kind === kind && ['pending', 'running'].includes(r.status));
function md(src) { // 간단한 마크다운 표시(제목, 굵게, 목록, 표)
  const inl = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const out = []; const L = String(src || '').split('\n'); let i = 0;
  while (i < L.length) {
    const l = L[i];
    if (/^\s*\|.*\|\s*$/.test(l)) { const rows = []; while (i < L.length && /^\s*\|.*\|\s*$/.test(L[i])) rows.push(L[i++]);
      const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const body = rows.filter(r => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
      out.push(`<div class="scroll-x"><table class="mdt">${body.map((r, k) => `<tr>${cells(r).map(c => k ? `<td>${inl(c)}</td>` : `<th>${inl(c)}</th>`).join('')}</tr>`).join('')}</table></div>`); continue; }
    const h = l.match(/^(#{1,4})\s+(.*)/); if (h) { out.push(`<h${Math.min(4, h[1].length + 1)} class="mdh">${inl(h[2])}</h${Math.min(4, h[1].length + 1)}>`); i++; continue; }
    if (/^\s*[-*]\s+/.test(l) || /^\s*\d+\.\s+/.test(l)) { const items = []; while (i < L.length && (/^\s*[-*]\s+/.test(L[i]) || /^\s*\d+\.\s+/.test(L[i]))) items.push(L[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''));
      out.push(`<ul class="mdl">${items.map(x => `<li>${inl(x)}</li>`).join('')}</ul>`); continue; }
    if (!l.trim()) { i++; continue; }
    if (/^>\s?/.test(l)) { out.push(`<p class="mdq">${inl(l.replace(/^>\s?/, ''))}</p>`); i++; continue; }
    out.push(`<p>${inl(l)}</p>`); i++;
  }
  return `<div class="md">${out.join('')}</div>`;
}
function requestBar() {
  const lastPf = S.daily[S.daily.length - 1];
  const ref = active('refresh'), rep = active('report');
  const recent = S.requests.slice(0, 6);
  return `<div class="card reqbar">
    <div class="reqtop"><div><b>지표 기준</b> <span class="hint">${lastPf ? kts(lastPf.collected_at) + ' 수집' : '수집 기록 없음'}</span></div>
      <div class="toolbar" style="margin:0">
        <button class="btn primary" id="reqRefresh" ${ref ? 'disabled' : ''}>${ref ? (ref.status === 'running' ? '업데이트 중…' : '업데이트 대기 중') : '지금 업데이트'}</button>
        <button class="btn dark" id="reqReportOpen">${S.reqForm ? '요청 닫기' : '리포트 요청'}</button></div></div>
    ${ref || rep ? `<p class="hint" style="margin:8px 0 0">Aside가 15분마다(07~23시) 확인해서 처리해요. 이 컴퓨터와 Aside가 켜져 있어야 해요. 끝나면 이 화면이 자동으로 바뀌어요.</p>` : ''}
    ${S.reqForm ? `<form id="reqForm" class="reqform">
      <div class="toolbar" style="margin:10px 0 6px">
        <select id="rqScope">${Object.entries(SCOPE).map(([k, l]) => `<option value="${k}" ${k === (IG() ? 'instagram' : 'all') ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select id="rqRange">${Object.entries(RANGE).map(([k, l]) => `<option value="${k}" ${k === 'today' ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <textarea id="rqQ" rows="3" placeholder="궁금한 점(선택) 예: 오늘 어떤 글이 팔로우를 만들었어? 릴스는 왜 팔로우가 0일까?"></textarea>
      <div class="toolbar" style="margin:8px 0 0"><button class="btn primary" type="submit" ${rep ? 'disabled' : ''}>${rep ? '이미 요청한 리포트가 있어요' : '요청하기'}</button>
      <span class="hint">최신 지표를 먼저 모은 뒤 분석해요.</span></div></form>` : ''}
    ${recent.length ? `<div class="reqlist">${recent.map(r => `<div class="reqrow st-${r.status}">
      <div class="rqh"><span>${r.kind === 'refresh' ? '지표 업데이트' : '리포트'}${r.kind === 'report' ? ` · ${SCOPE[r.params?.scope] || ''} · ${RANGE[r.params?.range] || ''}` : ''}</span>
        <span class="hint">${kts(r.created_at)} 요청${r.finished_at ? ' · ' + kts(r.finished_at) + ' 완료' : ''}</span><span class="pill">${RQ[r.status] || r.status}</span>
        ${['pending'].includes(r.status) ? `<button class="btn sm" data-rqcancel="${r.id}">취소</button>` : ''}
        ${r.result_md ? `<button class="btn sm" data-rqopen="${r.id}">${S.openReq === r.id ? '접기' : '보기'}</button>` : ''}</div>
      ${r.params?.question ? `<div class="hint">질문: ${esc(r.params.question)}</div>` : ''}${r.note ? `<div class="hint">${esc(r.note)}</div>` : ''}
      ${S.openReq === r.id && r.result_md ? `<div class="reqres">${md(r.result_md)}<div class="toolbar" style="margin:8px 0 0"><button class="btn sm" data-rqcopy="${r.id}">텍스트 복사</button></div></div>` : ''}</div>`).join('')}</div>` : ''}
  </div>`;
}
function pollRequests() {
  clearTimeout(S._poll);
  if (!S.requests.some(r => ['pending', 'running'].includes(r.status))) return;
  S._poll = setTimeout(async () => {
    const changed = await loadRequests();
    if (changed.some(r => r.kind === 'refresh' && r.status === 'done') || changed.some(r => r.kind === 'report' && r.status === 'done')) { await loadAll(); toast(changed.some(r => r.kind === 'report') ? '요청한 리포트가 도착했어요' : '최신 지표로 업데이트했어요'); const rep = changed.find(r => r.kind === 'report' && r.status === 'done'); if (rep) S.openReq = rep.id; }
    else if (changed.some(r => r.status === 'failed')) toast('요청을 처리하지 못했어요. 안내를 확인해 주세요');
    if (S.tab === 'report' && !document.activeElement?.closest?.('#reqForm')) render(); pollRequests();
  }, 20000);
}

/* ---------- AI 리포트 요약 + 초안 (Aside 루틴이 매일 아침 올림) ---------- */
const ST = { draft: '초안', approved: '승인됨 · 예약 대기', scheduled: '예약됨', failed: '예약 실패', skipped: '건너뜀' };
const needsCheck = s => /\[확인/.test(s || '');
const slotK = d => new Date(Date.parse(d.slot_at) + KST).toISOString();
const slotLabel = d => { const k = slotK(d); const day = k.slice(0, 10); return `${day === todayK() ? '오늘' : day === shiftDay(todayK(), 1) ? '내일' : dayLabel(day)} ${k.slice(11, 16)}`; };
const bodyOf = d => S.edits[d.id] ?? d.body;
const tooLate = d => Date.parse(d.slot_at) < Date.now() + 70 * 60e3;
function aiReportCard() {
  const r = S.reports[0]; if (!r) return '';
  const ds = S.drafts.filter(d => d.report_day === r.day && (d.platform || 'threads') === S.platform);
  const waiting = ds.filter(d => d.status === 'draft' && !tooLate(d)).length;
  const chips = (r.summary || []).map(s => `<span class="chip">${esc(s.label)} <b>${esc(s.value)}</b>${s.note ? ` <span class="${/^\+/.test(s.note) ? 'up' : /^-/.test(s.note) ? 'down' : 'muted'}">${esc(s.note)}</span>` : ''}</span>`).join('');
  return `<div class="action"><div class="l">${dayLabel(r.day)} AI 리포트 · 오늘의 핵심 행동</div>
    <div class="v">${esc(r.key_action || '')}</div><div class="s">${esc(r.key_reason || '')}</div>
    ${chips ? `<div class="chips" style="margin-top:10px">${chips}</div>` : ''}
    <div class="toolbar" style="margin:12px 0 0">${ds.length ? `<button class="btn sm primary" data-tab="drafts">초안 ${ds.length}개 보기${waiting ? ` · 승인 대기 ${waiting}` : ''}</button>` : ''}
    ${r.report_md ? `<button class="btn sm" id="toggleFull">${S.showFull ? '리포트 전문 접기' : '리포트 전문 보기'}</button>` : ''}</div>
    ${S.showFull && r.report_md ? `<div class="fullrep">${md(r.report_md)}</div>` : ''}</div>`;
}
function vDrafts() {
  const mine = S.drafts.filter(d => (d.platform || 'threads') === S.platform);
  const days = [...new Set(mine.map(d => d.report_day))].sort().reverse();
  if (!days.length) return `<div class="card empty">아직 ${IG() ? '인스타' : '스레드'} 초안이 없어요.<br>${IG() ? '블로그에 새 글이 올라오면 매일 아침 릴스 대본과 캐러셀 초안이 여기에 올라와요.' : '매일 아침 리포트가 끝나면 그날 시간대별 스레드 초안이 여기에 올라와요.'}</div>`;
  const day = S.draftDay && days.includes(S.draftDay) ? S.draftDay : days[0];
  const ds = mine.filter(d => d.report_day === day).sort((a, b) => a.slot_at.localeCompare(b.slot_at));
  const ready = ds.filter(d => d.status === 'draft' && canApprove(d));
  const cards = ds.map(d => {
    const b = bodyOf(d), lock = ['scheduled', 'skipped'].includes(d.status), late = tooLate(d) && ['draft', 'approved'].includes(d.status);
    const dirty = S.edits[d.id] != null && S.edits[d.id] !== d.body;
    const ig = d.platform === 'instagram', media = Array.isArray(d.media) ? d.media : [];
    return `<div class="card draft st-${d.status}" data-id="${d.id}">
      <div class="dhead"><b>${slotLabel(d)}</b>${ig && d.draft_kind ? `<span class="chip">${KIND[d.draft_kind] || esc(d.draft_kind)}</span>` : ''}${d.role ? `<span class="chip">${esc(d.role)}</span>` : ''}${d.experiment ? `<span class="chip hot">${esc(d.experiment)}</span>` : ''}<span class="pill">${ST[d.status] || d.status}</span></div>
      ${d.scheduled_label ? `<p class="hint">${ig ? '인스타' : '스레드'}: ${esc(d.scheduled_label)}</p>` : ''}${d.status_note ? `<p class="hint">${esc(d.status_note)}</p>` : ''}
      ${media.length ? `<div class="thumbs">${media.map((m, i) => `<img data-path="${esc(m.path || '')}" alt="${i + 1}장" loading="lazy">`).join('')}</div><p class="hint">${media.length}장 · 이미지를 누르면 크게 볼 수 있어요</p>` : ''}
      ${ig ? '<div class="hint" style="margin-bottom:4px">캐션</div>' : ''}
      <textarea class="dbody" data-id="${d.id}" rows="${Math.min(14, b.split('\n').length + 1)}" ${lock ? 'readonly' : ''}>${esc(b)}</textarea>
      <div class="hint">${b.length}자${ig && b.length > 2200 ? ' · <span class="down">인스타 캐션은 2,200자까지예요</span>' : ''}${needsCheck(b) ? ' · <span class="down">[확인] 부분을 채워야 승인할 수 있어요</span>' : ''}${late ? ' · <span class="down">게시 시각이 1시간 안쪽이라 자동 예약이 어려워요. 직접 올려 주세요</span>' : ''}${ig && d.draft_kind === 'reel' ? ' · 릴스는 휴대폰으로 촬영해서 인스타 앱에서 올려요(음악은 앱에서만 추가돼요)' : ''}${ig && d.draft_kind !== 'reel' && !media.length ? ' · <span class="down">이미지가 없어서 예약할 수 없어요</span>' : ''}</div>
      ${d.extra ? `<details class="extra" ${d.draft_kind === 'reel' ? 'open' : ''}><summary>${d.draft_kind === 'reel' ? '릴스 대본 · 촬영 컷' : '추가 정보'}</summary><div class="extratxt">${esc(d.extra)}</div><button class="btn sm" data-dact="copyExtra" data-id="${d.id}">대본 복사</button></details>` : ''}
      ${d.self_reply ? `<div class="reply"><div class="l">올린 직후 본인 답글</div><div class="txt">${esc(d.self_reply)}</div><button class="btn sm" data-dact="copyReply" data-id="${d.id}">답글 복사</button></div>` : ''}
      ${d.rationale ? `<p class="hint">근거: ${esc(d.rationale)}</p>` : ''}
      ${d.sources ? `<details class="hint"><summary>사실 출처</summary><div style="white-space:pre-wrap">${esc(d.sources)}</div></details>` : ''}
      <div class="toolbar" style="margin:10px 0 0">
        <button class="btn sm" data-dact="copy" data-id="${d.id}">본문 복사</button>
        ${lock ? '' : `<button class="btn sm ${dirty ? 'dark' : ''}" data-dact="save" data-id="${d.id}" ${dirty ? '' : 'disabled'}>수정 저장</button>`}
        ${(d.status === 'draft' || d.status === 'failed') && !(ig && d.draft_kind === 'reel') ? `<button class="btn sm primary" data-dact="approve" data-id="${d.id}" ${canApprove(d) ? '' : 'disabled'}>예약 승인</button>` : ''}
        ${ig && d.draft_kind === 'reel' && d.status === 'draft' ? `<button class="btn sm" data-dact="done" data-id="${d.id}">올렸어요</button>` : ''}
        ${d.status === 'approved' ? `<button class="btn sm" data-dact="unapprove" data-id="${d.id}">승인 취소</button>` : ''}
        ${d.status === 'draft' || d.status === 'failed' ? `<button class="btn sm" data-dact="skip" data-id="${d.id}">건너뛰기</button>` : ''}
        ${d.status === 'skipped' ? `<button class="btn sm" data-dact="restore" data-id="${d.id}">되살리기</button>` : ''}
        ${d.status === 'scheduled' ? `<span class="hint">${ig ? '수정·삭제는 인스타 앱 프로필 > 예약된 콘텐츠에서' : '수정·삭제는 스레드 앱 임시 저장본에서'}</span>` : ''}
      </div></div>`;
  }).join('');
  return `<div class="toolbar">
      <select id="draftDay">${days.map(x => `<option value="${x}" ${x === day ? 'selected' : ''}>${dayLabel(x)} 리포트 초안</option>`).join('')}</select>
      <button class="btn primary" data-dact="approveAll" ${ready.length ? '' : 'disabled'}>확인 필요 없는 초안 모두 승인 (${ready.length})</button>
      <button class="btn" id="reload">새로고침</button></div>
    <div class="card" style="background:#fffaf5"><p class="hint" style="margin:0">${IG()
      ? '캐러셀·사진 초안을 승인하면 Aside가 1시간마다(07~22시) 확인해서 인스타 콘텐츠 예약 기능으로 걸어요. 예약되면 컴퓨터가 꺼져 있어도 올라가요. 릴스는 대본을 보고 휴대폰으로 찍어 올리고, 올린 뒤 &#39;올렸어요&#39;를 눌러 주세요. 게시 1시간 전까지는 승인해 주세요.'
      : '승인한 초안은 Aside가 1시간마다(07~22시) 확인해서 스레드 예약 기능으로 걸어요. 예약되면 &#39;예약됨&#39;으로 바뀌고, 그때부터는 컴퓨터가 꺼져 있어도 올라가요. 게시 1시간 전까지는 승인해 주세요. 본인 답글은 예약이 안 돼서 올라간 뒤 직접 달아야 해요.'}</p></div>
    ${cards}`;
}
function canApprove(d) {
  const b = bodyOf(d); if (needsCheck(b) || tooLate(d)) return false;
  if (d.platform === 'instagram') { if (d.draft_kind === 'reel') return false; if (!(Array.isArray(d.media) && d.media.length)) return false; if (b.length > 2200) return false; }
  return true;
}
async function loadThumbs() {
  const imgs = [...document.querySelectorAll('.thumbs img[data-path]')].filter(i => i.dataset.path);
  const need = [...new Set(imgs.map(i => i.dataset.path).filter(p => !S.signed[p]))];
  if (need.length) {
    const { data } = await sb.storage.from('sns-media').createSignedUrls(need, 3600);
    for (const x of data || []) if (x.signedUrl) S.signed[x.path] = x.signedUrl;
  }
  for (const i of imgs) if (S.signed[i.dataset.path]) i.src = S.signed[i.dataset.path];
}
async function updDraft(id, patch) {
  const { data, error } = await sb.from('sns_drafts').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).select().single();
  if (error) { toast('실패: ' + error.message); return null; }
  S.drafts = S.drafts.map(x => x.id === id ? data : x); delete S.edits[id]; return data;
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
    ...(IG() ? [['릴스', p => p.media_kind === 'reel'], ['캐러셀', p => p.media_kind === 'carousel'], ['사진 1장', p => p.media_kind === 'image']] : []),
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
      <div class="kpi"><div class="l">글당 좋아요 / ${IG() ? '댓글' : '답글'}</div><div class="v">${fmt(avg(ps, 'likes'))} / ${fmt(avg(ps, 'replies'))}</div><div class="d muted">${IG() ? `저장 ${fmt1(avg(ps, 'saves'))} · 공유 ${fmt1(avg(ps, 'shares'))} · 비팔로워 ${fmt1(avg(ps, 'nonfollower_view_pct'))}%` : `리포스트 ${fmt1(avg(ps, 'reposts'))}`}</div></div>
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
  if (IG()) return `<div class="card empty">인스타 계정 추적은 아직 지원하지 않아요. 스레드로 전환하면 추적 계정을 볼 수 있어요.</div>`;
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
  if (t.dataset.rqopen) { S.openReq = S.openReq === t.dataset.rqopen ? null : t.dataset.rqopen; return render(); }
  if (t.dataset.rqcopy) { const r = S.requests.find(x => x.id === t.dataset.rqcopy); await navigator.clipboard.writeText(r?.result_md || ''); return toast('리포트를 복사했어요'); }
  if (t.dataset.rqcancel) { await sb.from('sns_requests').update({ status: 'canceled', finished_at: new Date().toISOString() }).eq('id', t.dataset.rqcancel).eq('status', 'pending'); await loadRequests(); toast('요청을 취소했어요'); return render(); }
  if (t.dataset.pf) { S.platform = t.dataset.pf; localStorage.setItem('sns_pf', S.platform); S.draftDay = null; S.reportDay = null; applyPlatform(); if (IG() && S.tab === 'track') S.tab = 'report'; return render(); }
  if (t.dataset.dact) {
    const id = t.dataset.id, d = S.drafts.find(x => x.id === id);
    switch (t.dataset.dact) {
      case 'copy': await navigator.clipboard.writeText(bodyOf(d)); return toast('본문을 복사했어요');
      case 'copyReply': await navigator.clipboard.writeText(d.self_reply || ''); return toast('답글을 복사했어요');
      case 'copyExtra': await navigator.clipboard.writeText(d.extra || ''); return toast('대본을 복사했어요');
      case 'done': if (await updDraft(id, { status: 'scheduled', status_note: '직접 올림', scheduled_label: '휴대폰으로 올림' })) toast('올린 것으로 표시했어요'); return render();
      case 'save': if (await updDraft(id, { body: bodyOf(d) })) toast('저장했어요'); return render();
      case 'approve': { const b = bodyOf(d); if (needsCheck(b)) return toast('[확인] 부분을 먼저 채워 주세요'); if (!canApprove({ ...d, body: b })) return toast('이 초안은 예약할 수 없어요');
        if (await updDraft(id, { body: b, status: 'approved', approved_at: new Date().toISOString(), status_note: null })) toast(`승인했어요. 1시간 안에 ${d.platform === 'instagram' ? '인스타' : '스레드'}에 예약돼요`); return render(); }
      case 'unapprove': if (await updDraft(id, { status: 'draft', approved_at: null })) toast('승인을 취소했어요'); return render();
      case 'skip': if (await updDraft(id, { status: 'skipped' })) toast('건너뛰었어요'); return render();
      case 'restore': if (await updDraft(id, { status: 'draft', status_note: null })) toast('되살렸어요'); return render();
      case 'approveAll': {
        const mine = S.drafts.filter(x => (x.platform || 'threads') === S.platform);
        const days = [...new Set(mine.map(x => x.report_day))].sort().reverse();
        const day = S.draftDay && days.includes(S.draftDay) ? S.draftDay : days[0];
        const list = mine.filter(x => x.report_day === day && x.status === 'draft' && canApprove(x));
        for (const x of list) await updDraft(x.id, { body: bodyOf(x), status: 'approved', approved_at: new Date().toISOString(), status_note: null });
        toast(`${list.length}개 승인했어요`); return render();
      }
    }
  }
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
    case 'toggleFull': S.showFull = !S.showFull; return render();
    case 'reqReportOpen': S.reqForm = !S.reqForm; return render();
    case 'reqRefresh': {
      if (active('refresh')) return toast('이미 요청했어요');
      const { error } = await sb.from('sns_requests').insert({ user_id: S.user.id, kind: 'refresh', params: { scope: 'all' } });
      if (error) return toast('실패: ' + error.message);
      await loadRequests(); toast('업데이트를 요청했어요. 보통 15분 안에 반영돼요'); return render();
    }
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
$app.addEventListener('click', e => { const im = e.target.closest('.thumbs img'); if (im?.src) window.open(im.src, '_blank'); });
$app.addEventListener('input', e => {
  if (e.target.classList.contains('dbody')) {
    const id = e.target.dataset.id; S.edits[id] = e.target.value;
    const d = S.drafts.find(x => x.id === id); const card = e.target.closest('.draft');
    const sv = card.querySelector('[data-dact="save"]'); if (sv) { const dirty = e.target.value !== d.body; sv.disabled = !dirty; sv.classList.toggle('dark', dirty); }
    const ap = card.querySelector('[data-dact="approve"]'); if (ap) ap.disabled = !canApprove({ ...d, body: e.target.value });
    return;
  }
  if (e.target.id === 'postQ') { S.postQ = e.target.value; clearTimeout(S._q); S._q = setTimeout(() => { const pos = e.target.selectionStart; render(); const el = document.getElementById('postQ'); el.focus(); el.setSelectionRange(pos, pos); }, 250); }
});
$app.addEventListener('change', e => {
  if (e.target.id === 'postSort') { S.postSort = e.target.value; render(); }
  if (e.target.id === 'postRange') { S.postRange = e.target.value; render(); }
  if (e.target.id === 'repDay' && e.target.value) { S.reportDay = e.target.value; render(); }
  if (e.target.id === 'draftDay') { S.draftDay = e.target.value; render(); }
});
$app.addEventListener('submit', async e => {
  if (e.target.id === 'reqForm') {
    e.preventDefault();
    if (active('report')) return toast('이미 요청한 리포트가 있어요');
    const params = { scope: document.getElementById('rqScope').value, range: document.getElementById('rqRange').value, question: document.getElementById('rqQ').value.trim() || null };
    const { error } = await sb.from('sns_requests').insert({ user_id: S.user.id, kind: 'report', params });
    if (error) return toast('실패: ' + error.message);
    S.reqForm = false; await loadRequests(); toast('리포트를 요청했어요. 보통 15~20분 안에 도착해요'); return render();
  }
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
