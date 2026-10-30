// 더원 스레드 수집기 - 백그라운드 서비스 워커
// 로그인된 브라우저에서 Threads 인사이트/프로필 페이지를 백그라운드 탭으로 열어 숫자를 읽고,
// 수집 키로 Supabase 에 저장합니다. 게시·수정 같은 쓰기 동작은 하지 않습니다.
importScripts('scrapers.js');

const SUPABASE_URL = 'https://gcnfvcbatpohhctitnkl.supabase.co';
const SUPABASE_KEY = 'sb_publishable_8zyr4Cia8y1JiVOguUC12Q_ZOknEH3F';
const APP_URL = 'https://sns-daily-report.vercel.app';
const TH = 'https://www.threads.com';
const KST = 9 * 3600e3;
const DEFAULTS = { key: '', autoTime: '07:00', autoOn: true, recheckDays: 3, maxPosts: 60 };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const kstDay = (ms = Date.now()) => new Date(ms + KST).toISOString().slice(0, 10);
const getSettings = async () => ({ ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) });

async function log(msg) {
  const { logs = [] } = await chrome.storage.local.get('logs');
  const line = new Date(Date.now() + KST).toISOString().slice(5, 19).replace('T', ' ') + '  ' + msg;
  logs.unshift(line);
  await chrome.storage.local.set({ logs: logs.slice(0, 60), status: msg });
  chrome.runtime.sendMessage({ type: 'log', line }).catch(() => { });
}

async function rpc(fn, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(/invalid_key/.test(t) ? '수집 키가 맞지 않습니다. 웹앱 설정에서 키를 다시 복사하세요.' : `${fn} ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

function waitComplete(tabId, timeout = 30000) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (done) return; done = true; chrome.tabs.onUpdated.removeListener(lis); clearTimeout(timer); resolve(); };
    const lis = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    const timer = setTimeout(finish, timeout);
    chrome.tabs.onUpdated.addListener(lis);
    chrome.tabs.get(tabId).then(t => { if (t.status === 'complete') finish(); }).catch(finish);
  });
}

async function goto(tabId, url, settle = 2500) {
  await chrome.tabs.update(tabId, { url });
  await sleep(400);
  await waitComplete(tabId);
  await sleep(settle);
}

async function run(tabId, func, args) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args: [args || {}] });
  return res ? res.result : null;
}

let running = false;

async function collect({ mode = 'daily', days = 60 } = {}) {
  if (running) { await log('이미 수집 중입니다.'); return; }
  running = true;
  const s = await getSettings();
  let tab = null;
  try {
    if (!s.key) throw new Error('수집 키가 없습니다. 팝업에 웹앱 설정의 수집 키를 붙여넣으세요.');
    await log(mode === 'backfill' ? `과거 글 가져오기 시작 (최근 ${days}일)` : '데일리 수집 시작');
    const cfg = await rpc('sns_ext_config', { p_key: s.key });
    const known = new Map((cfg.known_posts || []).map(p => [p.code, p]));
    const now = Date.now();
    const recheckCut = now - s.recheckDays * 864e5;
    const listCut = mode === 'backfill' ? now - days * 864e5 : now - Math.max(s.recheckDays, 2) * 864e5;

    tab = await chrome.tabs.create({ url: TH + '/insights?days=7', active: false });
    await waitComplete(tab.id); await sleep(3000);
    const o7 = await run(tab.id, scrapeOverview, { listPosts: true, cutoffMs: listCut, maxScroll: mode === 'backfill' ? 120 : 25 });
    if (!o7 || o7.error === 'not_logged_in') throw new Error('Threads 로그인이 필요합니다. 이 브라우저에서 threads.com 에 로그인하세요.');
    const handle = o7.handle || cfg.handle;
    await log(`@${handle} 인사이트 7일: 조회 ${o7.views ?? '-'}, 게시물 ${o7.posts.length}개 확인`);

    await goto(tab.id, TH + '/insights?days=30', 3000);
    const o30 = await run(tab.id, scrapeOverview, { listPosts: false });

    // 내 프로필: 실시간 팔로워 수 + 인사이트 목록에 아직 없는 최신 글
    await goto(tab.id, `${TH}/@${handle}`, 2500);
    const me = await run(tab.id, scrapeProfile, { handle });

    const account = {
      followers: me && me.followers, insights_followers: o7.insights_followers,
      views_7d: o7.views, viewers_7d: o7.viewers, reactions_7d: o7.reactions, net_followers_7d: o7.net_followers,
      views_30d: o30 && o30.views, viewers_30d: o30 && o30.viewers, reactions_30d: o30 && o30.reactions, net_followers_30d: o30 && o30.net_followers,
      follower_viewers_7d: o7.follower_viewers, nonfollower_viewers_7d: o7.nonfollower_viewers,
      raw: { active_time: o7.active_time },
    };

    // 다시 읽을 게시물 고르기
    const cand = new Map();
    for (const p of o7.posts) cand.set(p.code, p.ts);
    for (const p of (me && me.recent_posts) || []) if (p.taken_at * 1000 >= listCut) cand.set(p.code, p.taken_at * 1000);
    let targets = [...cand.entries()].filter(([code, ts]) => {
      if (ts < listCut) return false;
      if (ts >= recheckCut) return true;            // 최근 글은 매번 갱신
      return !known.has(code);                      // 오래된 글은 처음 한 번만
    }).sort((a, b) => b[1] - a[1]);
    const cap = mode === 'backfill' ? 80 : s.maxPosts; // 한 번에 너무 많이 열면 Threads가 잠시 막음. 다시 누르면 이어서 가져옴
    if (targets.length > cap) targets = targets.slice(0, cap);

    const posts = [];
    let fails = 0;
    for (let i = 0; i < targets.length; i++) {
      const [code, ts] = targets[i];
      await goto(tab.id, `${TH}/insights/post/${code}?without_navigation=false`, 1800);
      const r = await run(tab.id, scrapePost, { handle });
      if (!r || r.error) {
        fails++;
        if (r && r.error === 'rate_limited') { await log('Threads가 잠시 조회를 막았습니다. 남은 글은 다음 수집 때 이어서 읽습니다.'); break; }
        if (fails >= 5) break;
        continue;
      }
      posts.push({ code, posted_at: new Date(ts).toISOString(), ...r });
      if ((i + 1) % 10 === 0) await log(`게시물 ${i + 1}/${targets.length} 읽음`);
      await sleep(mode === 'backfill' ? 2500 : 1200);
    }

    // 추적 계정
    const tracked = [];
    for (const h of cfg.tracked || []) {
      await goto(tab.id, `${TH}/@${h}`, 2200);
      const r = await run(tab.id, scrapeProfile, { handle: h });
      if (r && !r.error && r.followers != null) tracked.push(r);
      await sleep(800);
    }

    // 저장 (게시물이 많으면 나눠서)
    const day = kstDay();
    const note = `${mode} posts ${posts.length}/${targets.length}, tracked ${tracked.length}/${(cfg.tracked || []).length}`;
    let res = await rpc('sns_ingest', { p_key: s.key, p_payload: { day, handle, account, posts: posts.slice(0, 40), tracked, note } });
    for (let k = 40; k < posts.length; k += 40) {
      await rpc('sns_ingest', { p_key: s.key, p_payload: { day, handle, posts: posts.slice(k, k + 40), note } });
    }
    await chrome.storage.local.set({ lastRunDay: day, lastRunAt: Date.now() });
    const msg = `완료: 팔로워 ${account.followers ?? '-'}, 게시물 ${posts.length}개, 추적 ${tracked.length}개 저장`;
    await log(msg);
    try { chrome.notifications.create({ type: 'basic', iconUrl: 'icon128.png', title: '스레드 데일리 리포트', message: msg }); } catch (e) { }
  } catch (e) {
    await log('오류: ' + (e && e.message ? e.message : e));
  } finally {
    if (tab) { try { await chrome.tabs.remove(tab.id); } catch (e) { } }
    running = false;
  }
}

// 자동 수집: 30분마다 확인해서, 오늘 예약 시각이 지났고 아직 안 했으면 실행 (PC가 꺼져 있던 날도 켜지면 따라잡음)
async function maybeAuto() {
  const s = await getSettings();
  if (!s.autoOn || !s.key) return;
  const { lastRunDay } = await chrome.storage.local.get('lastRunDay');
  const today = kstDay();
  if (lastRunDay === today) return;
  const [hh, mm] = (s.autoTime || '07:00').split(':').map(Number);
  const nowK = new Date(Date.now() + KST);
  if (nowK.getUTCHours() * 60 + nowK.getUTCMinutes() >= hh * 60 + mm) collect({ mode: 'daily' });
}

chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create('auto', { periodInMinutes: 30, delayInMinutes: 1 }); });
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create('auto', { periodInMinutes: 30, delayInMinutes: 2 }); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'auto') maybeAuto(); });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'collect') { collect({ mode: msg.mode || 'daily', days: msg.days || 60 }); sendResponse({ ok: true }); }
  if (msg.type === 'running') sendResponse({ running });
  if (msg.type === 'testKey') {
    rpc('sns_ext_config', { p_key: msg.key }).then(c => sendResponse({ ok: true, cfg: c })).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});
