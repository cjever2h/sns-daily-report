-- SNS 데일리 리포트 앱: 지금 업데이트 / 리포트 요청 큐 (2026-11-04)
create table if not exists sns_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  kind text not null check (kind in ('refresh', 'report')),
  params jsonb,                 -- {scope:'all'|'threads'|'instagram'|'blog', range:'today'|'yesterday'|'7d', question:'...'}
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed', 'canceled')),
  note text,                    -- 진행/실패 안내 (사용자에게 보임)
  result_md text,               -- 리포트 결과 (마크다운)
  created_at timestamptz default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index if not exists sns_requests_user_idx on sns_requests (user_id, created_at desc);
alter table sns_requests enable row level security;
drop policy if exists own_all on sns_requests;
create policy own_all on sns_requests for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Aside 루틴: 한 번에 할 일 확인 (승인된 초안 + 대기 요청)
create or replace function sns_queue(p_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid;
begin
  select user_id into v_uid from sns_settings where ingest_key = p_key;
  if v_uid is null then raise exception 'invalid_key'; end if;
  -- 30분 넘게 running 이면 다시 pending 으로 (중단된 실행 복구)
  update sns_requests set status = 'pending', note = '이전 처리 중단, 다시 처리' where user_id = v_uid and status = 'running' and started_at < now() - interval '30 minutes';
  return jsonb_build_object(
    'approved', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'platform', platform, 'slot_at', slot_at, 'body', body, 'self_reply', self_reply,
        'role', role, 'draft_kind', draft_kind, 'media', media) order by slot_at) from sns_drafts where user_id = v_uid and status = 'approved'), '[]'::jsonb),
    'requests', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'params', params, 'created_at', created_at) order by created_at)
        from sns_requests where user_id = v_uid and status = 'pending'), '[]'::jsonb));
end $$;

create or replace function sns_request_update(p_key uuid, p_id uuid, p_status text, p_note text default null, p_result_md text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid;
begin
  select user_id into v_uid from sns_settings where ingest_key = p_key;
  if v_uid is null then raise exception 'invalid_key'; end if;
  if p_status not in ('pending','running','done','failed','canceled') then raise exception 'bad status'; end if;
  update sns_requests set status = p_status, note = coalesce(p_note, note), result_md = coalesce(p_result_md, result_md),
    started_at = case when p_status = 'running' then now() else started_at end,
    finished_at = case when p_status in ('done','failed','canceled') then now() else finished_at end
  where id = p_id and user_id = v_uid;
  return jsonb_build_object('ok', found);
end $$;

revoke all on function sns_queue(uuid) from public;
revoke all on function sns_request_update(uuid, uuid, text, text, text) from public;
grant execute on function sns_queue(uuid) to anon, authenticated;
grant execute on function sns_request_update(uuid, uuid, text, text, text) to anon, authenticated;
