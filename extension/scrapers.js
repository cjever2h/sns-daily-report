// 페이지 안에서 실행되는 수집 함수들 (chrome.scripting.executeScript 로 주입)
// 각 함수는 외부 변수를 쓰지 않는 독립 함수여야 합니다.

// 1) 인사이트 개요 페이지 (/insights?days=7 또는 30)
//    계정 요약 숫자 + 최신 게시물 shortcode 목록(스크롤하며 cutoff 이전까지)
async function scrapeOverview(opts) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const num = s => {
    if (s == null) return null;
    s = String(s).replace(/,/g, '').replace(/\u2212/g, '-').trim();
    const m = s.match(/^([+-]?[\d.]+)\s*(천|만|K|M|k)?/);
    if (!m) return null;
    let v = parseFloat(m[1]);
    if (m[2] === '천' || m[2] === 'K' || m[2] === 'k') v *= 1e3;
    if (m[2] === '만') v *= 1e4;
    if (m[2] === 'M') v *= 1e6;
    return Math.round(v);
  };
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const tsOf = sc => { let id = 0n; for (const c of sc.slice(0, 11)) id = id * 64n + BigInt(A.indexOf(c)); return Number(id >> 23n) + 1314220021721; };

  // 로딩 대기
  for (let i = 0; i < 20; i++) {
    if (document.querySelector('[aria-label*=": "]') && document.querySelector('a[href*="/insights/post/"]')) break;
    await sleep(700);
  }
  const text = document.body.innerText;
  if (/로그인|Log in/i.test(text) && !/인사이트|Insights/.test(text)) return { error: 'not_logged_in' };

  const aria = [...document.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label')).filter(l => /: /.test(l));
  const av = keys => { for (const k of keys) { const l = aria.find(x => x.startsWith(k + ': ')); if (l) return l.slice(k.length + 2); } return null; };

  const out = {
    views: num(av(['조회수', 'Views'])),
    viewers: num(av(['조회한 사람', 'Viewers'])),
    reactions: num(av(['반응', 'Interactions'])),
    net_followers: num(av(['순 팔로워', 'Net followers'])),
  };
  let m = text.match(/(?:^|\n)(?:팔로워|Followers)\n([\d,]+)\n[^\n]*\n(?:시간에 따른 팔로워|Follower growth|Followers over time)/);
  out.insights_followers = m ? num(m[1]) : null;
  m = text.match(/(?:조회한 사람 유형|Viewer types?)\n(?:팔로워|Followers)\n([\d,.]+(?:천|만|K|M)?)/);
  out.follower_viewers = m ? num(m[1]) : null;
  m = text.match(/(?:팔로워가 아닌 사람|Non-followers)\n([\d,.]+(?:천|만|K|M)?)/);
  out.nonfollower_viewers = m ? num(m[1]) : null;
  m = text.match(/(?:가장 활동이 많은 시간|Most active times)[^\n]*\n[^\n]*\n([^\n]+)\n([^\n]+)/);
  out.active_time = m ? (m[1] + ' ' + m[2]) : null;

  // 내 핸들: 왼쪽 메뉴의 프로필 링크
  const hs = [...document.querySelectorAll('a[href^="/@"]')].map(a => a.getAttribute('href').split('/')[1].slice(1)).filter(Boolean);
  out.handle = hs.length ? hs[0] : null;

  // 게시물 목록
  const codes = new Map();
  const cutoff = opts && opts.cutoffMs ? opts.cutoffMs : Date.now() - 7 * 864e5;
  const maxScroll = opts && opts.maxScroll ? opts.maxScroll : 25;
  for (let i = 0; i < maxScroll; i++) {
    for (const a of document.querySelectorAll('a[href*="/insights/post/"]')) {
      const sc = a.getAttribute('href').split('/insights/post/')[1].split(/[/?]/)[0];
      if (sc && !codes.has(sc)) codes.set(sc, tsOf(sc));
    }
    if (!opts || !opts.listPosts) break;
    const oldest = codes.size ? Math.min(...codes.values()) : Date.now();
    if (oldest < cutoff - 3600e3) break;
    const before = codes.size;
    const els = [...document.querySelectorAll('div')].filter(d => d.scrollHeight > d.clientHeight + 50 && d.querySelector('a[href*="/insights/post/"]'));
    const el = els[els.length - 1];
    if (el) el.scrollTop = el.scrollHeight;
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(1800);
    if (i > 3 && codes.size === before) {
      await sleep(1500);
      if (document.querySelectorAll('a[href*="/insights/post/"]').length <= before) break;
    }
  }
  out.posts = [...codes.entries()].map(([code, ts]) => ({ code, ts }));
  return out;
}

// 2) 게시물 인사이트 페이지 (/insights/post/CODE)
async function scrapePost(opts) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const num = s => {
    if (s == null) return null;
    s = String(s).replace(/,/g, '').trim();
    const m = s.match(/^([\d.]+)\s*(천|만|K|M|k)?/);
    if (!m) return null;
    let v = parseFloat(m[1]);
    if (m[2] === '천' || m[2] === 'K' || m[2] === 'k') v *= 1e3;
    if (m[2] === '만') v *= 1e4;
    if (m[2] === 'M') v *= 1e6;
    return Math.round(v);
  };
  let tx = '';
  for (let i = 0; i < 16; i++) {
    tx = document.body.innerText;
    if (/(요약|Overview)\n/.test(tx) && /(좋아요 비율|Like rate)/.test(tx)) break;
    if (/게시물을 읽어들일 수 없습니다|문제가 발생했습니다|Something went wrong/.test(tx)) return { error: 'rate_limited' };
    await sleep(600);
  }
  const start = Math.max(0, tx.search(/게시물 인사이트|Post insights/));
  const head = tx.slice(start);
  const sumIdx = head.search(/\n(요약|Overview)\n/);
  if (sumIdx < 0) return { error: 'not_loaded' };
  const seg = head.slice(sumIdx);
  // 본문: 헤더(게시물 인사이트 / 게시물 보기 / 핸들 / 시간) 다음부터 요약 전까지
  const lines = head.slice(0, sumIdx).split('\n');
  let i = 0;
  while (i < lines.length && !(opts && opts.handle && lines[i].trim() === opts.handle)) i++;
  const body = i < lines.length ? lines.slice(i + 2).join('\n') : lines.slice(4).join('\n');
  const g = re => { const m = seg.match(re); return m ? m[1] : null; };
  const rate = re => { const v = g(re); return v == null ? null : parseFloat(v); };
  const views = num(g(/(?:조회수|Views)\s*\n\s*([\d,.]+(?:천|만|K|M)?)/));
  const r = {
    like_rate: rate(/(?:좋아요 비율|Like rate)\s*\n\s*([\d.]+)%/),
    reply_rate: rate(/(?:응답률|Reply rate)\s*\n\s*([\d.]+)%/),
    share_rate: rate(/(?:공유 비율|Share rate)\s*\n\s*([\d.]+)%/),
    quote_rate: rate(/(?:인용 비율|Quote rate)\s*\n\s*([\d.]+)%/),
    repost_rate: rate(/(?:리포스트 비율|Repost rate)\s*\n\s*([\d.]+)%/),
  };
  const est = x => (x == null || views == null) ? null : Math.round(views * x / 100);
  const src = g(/(?:상위 조회 출처|Top sources)\n(?:추가 정보\n)?([\s\S]{0,120})/);
  return {
    text: body.trim().slice(0, 2000),
    views,
    viewers: num(g(/(?:조회한 사람|Viewers)\s*\n\s*([\d,.]+(?:천|만|K|M)?)/)),
    profile_visits: num(g(/(?:프로필 방문|Profile visits)\s*\n\s*([\d,]+)/)),
    follows: num(g(/(?:팔로우|Follows)\s*\n\s*([\d,]+)/)),
    ...r,
    likes: est(r.like_rate), replies: est(r.reply_rate), shares: est(r.share_rate), quotes: est(r.quote_rate), reposts: est(r.repost_rate),
    top_sources: src ? src.split('\n').slice(0, 6).join(' ').trim() : null,
  };
}

// 3) 공개 프로필 페이지 (/@handle) - 페이지에 포함된 JSON 에서 팔로워 수와 최근 글 반응
async function scrapeProfile(opts) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const handle = String(opts.handle || '').toLowerCase();
  for (let i = 0; i < 12; i++) { if (document.querySelector('script[type="application/json"]')) break; await sleep(500); }
  let user = null; const posts = new Map();
  const walk = (o, d) => {
    if (!o || typeof o !== 'object' || d > 80) return;
    if (Array.isArray(o)) { for (const x of o) walk(x, d + 1); return; }
    if (!user && typeof o.username === 'string' && o.username.toLowerCase() === handle && o.follower_count != null) user = o;
    if (o.code && o.taken_at && o.like_count != null && o.user && String(o.user.username).toLowerCase() === handle && !posts.has(o.code)) {
      const ti = o.text_post_app_info || {};
      posts.set(o.code, {
        code: o.code, taken_at: o.taken_at, likes: o.like_count,
        replies: ti.direct_reply_count ?? null, reposts: ti.repost_count ?? null, quotes: ti.quote_count ?? null,
        text: ((o.caption && o.caption.text) || '').slice(0, 120),
      });
    }
    for (const k in o) walk(o[k], d + 1);
  };
  for (const s of document.querySelectorAll('script[type="application/json"]')) {
    const t = s.textContent;
    if (!t || (t.indexOf('follower_count') < 0 && t.indexOf('taken_at') < 0)) continue;
    try { walk(JSON.parse(t), 0); } catch (e) { }
  }
  let followers = user ? user.follower_count : null;
  if (followers == null) {
    const m = document.body.innerText.match(/(?:팔로워|followers)\s*([\d,.]+)\s*(만|천|K|M)?\s*명?/i);
    if (m) { let v = parseFloat(m[1].replace(/,/g, '')); if (m[2] === '만') v *= 1e4; if (m[2] === '천' || m[2] === 'K') v *= 1e3; if (m[2] === 'M') v *= 1e6; followers = Math.round(v); }
  }
  if (followers == null && /페이지를 사용할 수 없습니다|isn't available|not available/i.test(document.body.innerText)) return { error: 'not_found' };
  return {
    handle,
    followers,
    full_name: user ? user.full_name : null,
    recent_posts: [...posts.values()].sort((a, b) => b.taken_at - a.taken_at).slice(0, 10),
  };
}
