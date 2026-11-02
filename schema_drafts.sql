-- SNS 데일리 리포트 앱: 초안 + 데일리 리포트 요약 (2026-11-03 추가)
create table if not exists sns_daily_reports (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  day date not null,
  key_action text,
  key_reason text,
  summary jsonb,          -- [{label, value, note}] 채널별 핵심 수치
  report_md text,         -- 리포트 전문 (마크다운)
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  primary key (user_id, day)
);

create table if not exists sns_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  platform text not null default 'threads',
  report_day date not null,
  slot_at timestamptz not null,
  role text,
  experiment text,
  body text not null,
  self_reply text,
  rationale text,
  sources text,
  status text not null default 'draft' check (status in ('draft','approved','scheduled','failed','skipped')),
  status_note text,
  scheduled_label text,
  approved_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, platform, slot_at)
);
create index if not exists sns_drafts_day_idx on sns_drafts (user_id, report_day desc);

do $$
declare t text;
begin
  foreach t in array array['sns_daily_reports','sns_drafts'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists own_all on %I', t);
    execute format('create policy own_all on %I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

-- 루틴 → 앱: 리포트 요약 + 하루치 초안 올리기 (수집 키 인증)
-- 이미 승인/예약된 슬롯은 덮어쓰지 않는다.
create or replace function sns_push_report(p_key uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid; v_day date := (p_payload->>'day')::date; d jsonb; n int := 0; kept int := 0; v_status text;
begin
  select user_id into v_uid from sns_settings where ingest_key = p_key;
  if v_uid is null then raise exception 'invalid_key'; end if;
  if v_day is null then raise exception 'day required'; end if;
  insert into sns_daily_reports as r (user_id, day, key_action, key_reason, summary, report_md, updated_at)
  values (v_uid, v_day, p_payload->>'key_action', p_payload->>'key_reason', p_payload->'summary', p_payload->>'report_md', now())
  on conflict (user_id, day) do update set key_action = coalesce(excluded.key_action, r.key_action), key_reason = coalesce(excluded.key_reason, r.key_reason),
    summary = coalesce(excluded.summary, r.summary), report_md = coalesce(excluded.report_md, r.report_md), updated_at = now();
  for d in select * from jsonb_array_elements(coalesce(p_payload->'drafts', '[]'::jsonb)) loop
    continue when coalesce(d->>'body', '') = '' or (d->>'slot_at') is null;
    select status into v_status from sns_drafts where user_id = v_uid and platform = 'threads' and slot_at = (d->>'slot_at')::timestamptz;
    if v_status in ('approved', 'scheduled') then kept := kept + 1; continue; end if;
    insert into sns_drafts as s (user_id, report_day, slot_at, role, experiment, body, self_reply, rationale, sources, status, status_note, scheduled_label, updated_at)
    values (v_uid, v_day, (d->>'slot_at')::timestamptz, d->>'role', d->>'experiment', d->>'body', d->>'self_reply', d->>'rationale', d->>'sources',
      coalesce(nullif(d->>'status', ''), 'draft'), d->>'status_note', d->>'scheduled_label', now())
    on conflict (user_id, platform, slot_at) do update set report_day = excluded.report_day, role = excluded.role, experiment = excluded.experiment,
      body = excluded.body, self_reply = excluded.self_reply, rationale = excluded.rationale, sources = excluded.sources,
      status = excluded.status, status_note = excluded.status_note, scheduled_label = excluded.scheduled_label, updated_at = now();
    n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'day', v_day, 'drafts', n, 'kept_approved', kept);
end $$;

-- 예약 루틴: 승인된 초안 가져오기
create or replace function sns_drafts_approved(p_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid;
begin
  select user_id into v_uid from sns_settings where ingest_key = p_key;
  if v_uid is null then raise exception 'invalid_key'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'slot_at', slot_at, 'body', body, 'self_reply', self_reply, 'role', role) order by slot_at)
    from sns_drafts where user_id = v_uid and status = 'approved'), '[]'::jsonb);
end $$;

-- 예약 루틴: 결과 기록
create or replace function sns_draft_mark(p_key uuid, p_id uuid, p_status text, p_note text default null, p_label text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid;
begin
  select user_id into v_uid from sns_settings where ingest_key = p_key;
  if v_uid is null then raise exception 'invalid_key'; end if;
  if p_status not in ('draft','approved','scheduled','failed','skipped') then raise exception 'bad status'; end if;
  update sns_drafts set status = p_status, status_note = p_note, scheduled_label = coalesce(p_label, scheduled_label), updated_at = now()
  where id = p_id and user_id = v_uid;
  return jsonb_build_object('ok', found);
end $$;

revoke all on function sns_push_report(uuid, jsonb) from public;
revoke all on function sns_drafts_approved(uuid) from public;
revoke all on function sns_draft_mark(uuid, uuid, text, text, text) from public;
grant execute on function sns_push_report(uuid, jsonb) to anon, authenticated;
grant execute on function sns_drafts_approved(uuid) to anon, authenticated;
grant execute on function sns_draft_mark(uuid, uuid, text, text, text) to anon, authenticated;
