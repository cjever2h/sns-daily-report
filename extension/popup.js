const APP_URL = 'https://sns-daily-report.vercel.app';
const $ = id => document.getElementById(id);

async function load() {
  const v = await chrome.storage.local.get(['key', 'autoOn', 'autoTime', 'recheckDays', 'status', 'logs']);
  $('key').value = v.key || '';
  $('autoOn').checked = v.autoOn !== false;
  $('autoTime').value = v.autoTime || '07:00';
  $('recheckDays').value = v.recheckDays || 3;
  $('status').textContent = v.status || '아직 수집 기록이 없습니다.';
  $('logs').textContent = (v.logs || []).slice(0, 20).join('\n');
  $('app').href = APP_URL;
}

$('save').onclick = async () => {
  const key = $('key').value.trim();
  $('keyMsg').innerHTML = '<small>확인 중…</small>';
  const r = await chrome.runtime.sendMessage({ type: 'testKey', key });
  if (r && r.ok) {
    await chrome.storage.local.set({ key });
    const n = (r.cfg.tracked || []).length;
    $('keyMsg').innerHTML = `<small class="ok">연결됨${r.cfg.handle ? ' · @' + r.cfg.handle : ''} · 추적 계정 ${n}개</small>`;
  } else {
    $('keyMsg').innerHTML = `<small class="err">${(r && r.error) || '연결 실패'}</small>`;
  }
};

for (const id of ['autoOn', 'autoTime', 'recheckDays']) {
  $(id).onchange = () => chrome.storage.local.set({
    autoOn: $('autoOn').checked,
    autoTime: $('autoTime').value || '07:00',
    recheckDays: Math.min(14, Math.max(1, Number($('recheckDays').value) || 3)),
  });
}

$('run').onclick = () => { chrome.runtime.sendMessage({ type: 'collect', mode: 'daily' }); $('status').textContent = '수집을 시작했습니다. 백그라운드 탭에서 진행됩니다(1~5분).'; };
$('backfill').onclick = () => { chrome.runtime.sendMessage({ type: 'collect', mode: 'backfill', days: 60 }); $('status').textContent = '과거 글을 가져오는 중입니다. 글이 많으면 10분 이상 걸립니다.'; };

chrome.runtime.onMessage.addListener(m => {
  if (m.type === 'log') { $('status').textContent = m.line.slice(16); $('logs').textContent = m.line + '\n' + $('logs').textContent; }
});

load();
