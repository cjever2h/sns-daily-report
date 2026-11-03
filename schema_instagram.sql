-- SNS 데일리 리포트 앱: 인스타그램 추가 (2026-11-03)
alter table sns_settings add column if not exists media_key uuid not null default gen_random_uuid();
alter table sns_settings add column if not exists ig_handle text;

alter table sns_account_daily add column if not exists following int;
alter table sns_account_daily add column if not exists posts_count int;
alter table sns_account_daily add column if not exists profile_visits_7d int;
alter table sns_account_daily add column if not exists nonfollower_view_pct_7d numeric;

alter table sns_posts add column if not exists media_kind text;            -- reel | carousel | image (instagram)
alter table sns_posts add column if not exists saves int;
alter table sns_posts add column if not exists interactions int;
alter table sns_posts add column if not exists nonfollower_view_pct numeric;

alter table sns_drafts add column if not exists draft_kind text;           -- text(threads) | carousel | image | reel
alter table sns_drafts add column if not exists media jsonb;               -- [{path:'<media_key>/..png', local:'C:/..png'}]
alter table sns_drafts add column if not exists extra text;                -- 릴스 대본/촬영 컷 등 (마크다운)

-- 초안 이미지 저장소 (비공개). 업로드: 경로 첫 폴더가 media_key 와 일치해야 함. 조회: 본인 media_key 폴더만.
insert into storage.buckets (id, name, public) values ('sns-media', 'sns-media', false) on conflict (id) do nothing;
drop policy if exists sns_media_insert on storage.objects;
create policy sns_media_insert on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'sns-media' and exists (select 1 from public.sns_settings s where s.media_key::text = (storage.foldername(name))[1]));
drop policy if exists sns_media_update on storage.objects;
create policy sns_media_update on storage.objects for update to anon, authenticated
  using (bucket_id = 'sns-media' and exists (select 1 from public.sns_settings s where s.media_key::text = (storage.foldername(name))[1]));
drop policy if exists sns_media_select on storage.objects;
create policy sns_media_select on storage.objects for select to authenticated
  using (bucket_id = 'sns-media' and exists (select 1 from public.sns_settings s where s.user_id = auth.uid() and s.media_key::text = (storage.foldername(name))[1]));

-- 인스타 데이터 수신 (수집 키 인증)
create or replace function sns_ingest_ig(p_key uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid; v_day date := coalesce((p_payload->>'day')::date, (now() at time zone 'Asia/Seoul')::date);
  v_handle text := nullif(p_payload->>'handle', ''); a jsonb; p jsonb; n int := 0;
begin
  select user_id into v_uid from sns_settings where ingest_key = p_key;
  if v_uid is null then raise exception 'invalid_key'; end if;
  a := p_payload->'account';
  if a is not null and jsonb_typeof(a) = 'object' then
    insert into sns_account_daily as d (user_id, platform, day, handle, followers, following, posts_count, views_7d, viewers_7d, reactions_7d,
      profile_visits_7d, nonfollower_view_pct_7d, raw, collected_at)
    values (v_uid, 'instagram', v_day, v_handle, (a->>'followers')::int, (a->>'following')::int, (a->>'posts_count')::int,
      (a->>'views_7d')::int, (a->>'viewers_7d')::int, (a->>'reactions_7d')::int, (a->>'profile_visits_7d')::int,
      (a->>'nonfollower_view_pct_7d')::numeric, a->'raw', now())
    on conflict (user_id, platform, day) do update set handle = coalesce(excluded.handle, d.handle),
      followers = coalesce(excluded.followers, d.followers), following = coalesce(excluded.following, d.following),
      posts_count = coalesce(excluded.posts_count, d.posts_count), views_7d = coalesce(excluded.views_7d, d.views_7d),
      viewers_7d = coalesce(excluded.viewers_7d, d.viewers_7d), reactions_7d = coalesce(excluded.reactions_7d, d.reactions_7d),
      profile_visits_7d = coalesce(excluded.profile_visits_7d, d.profile_visits_7d),
      nonfollower_view_pct_7d = coalesce(excluded.nonfollower_view_pct_7d, d.nonfollower_view_pct_7d), raw = coalesce(excluded.raw, d.raw), collected_at = now();
  end if;
  for p in select * from jsonb_array_elements(coalesce(p_payload->'posts', '[]'::jsonb)) loop
    continue when coalesce(p->>'code', '') = '';
    insert into sns_posts as s (user_id, platform, code, handle, posted_at, text, media_kind, views, viewers, profile_visits, follows,
      likes, replies, shares, saves, interactions, nonfollower_view_pct, updated_at)
    values (v_uid, 'instagram', p->>'code', v_handle, (p->>'posted_at')::timestamptz, p->>'text', p->>'media_kind',
      (p->>'views')::int, (p->>'viewers')::int, (p->>'profile_visits')::int, (p->>'follows')::int, (p->>'likes')::int, (p->>'comments')::int,
      (p->>'shares')::int, (p->>'saves')::int, (p->>'interactions')::int, (p->>'nonfollower_view_pct')::numeric, now())
    on conflict (user_id, platform, code) do update set handle = coalesce(excluded.handle, s.handle), posted_at = coalesce(excluded.posted_at, s.posted_at),
      text = coalesce(excluded.text, s.text), media_kind = coalesce(excluded.media_kind, s.media_kind),
      views = coalesce(excluded.views, s.views), viewers = coalesce(excluded.viewers, s.viewers), profile_visits = coalesce(excluded.profile_visits, s.profile_visits),
      follows = coalesce(excluded.follows, s.follows), likes = coalesce(excluded.likes, s.likes), replies = coalesce(excluded.replies, s.replies),
      shares = coalesce(excluded.shares, s.shares), saves = coalesce(excluded.saves, s.saves), interactions = coalesce(excluded.interactions, s.interactions),
      nonfollower_view_pct = coalesce(excluded.nonfollower_view_pct, s.nonfollower_view_pct), updated_at = now();
    if (p->>'views') is not null then
      insert into sns_post_snapshots as ps (user_id, platform, code, day, views, likes, replies, profile_visits, follows, collected_at)
      values (v_uid, 'instagram', p->>'code', v_day, (p->>'views')::int, (p->>'likes')::int, (p->>'comments')::int, (p->>'profile_visits')::int, (p->>'follows')::int, now())
      on conflict (user_id, platform, code, day) do update set views = excluded.views, likes = excluded.likes, replies = excluded.replies,
        profile_visits = excluded.profile_visits, follows = excluded.follows, collected_at = now();
    end if;
    n := n + 1;
  end loop;
  update sns_settings set ig_handle = coalesce(v_handle, ig_handle) where user_id = v_uid;
  return jsonb_build_object('ok', true, 'day', v_day, 'posts', n);
end $$;

-- 미디어 폴더 키 조회 (수집 키 인증)
create or replace function sns_media_key(p_key uuid)
returns uuid language sql security definer set search_path = public as $$
  select media_key from sns_settings where ingest_key = p_key;
$$;

-- 초안 올리기: platform, draft_kind, media, extra 지원으로 교체
create or replace function sns_push_report(p_key uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid; v_day date := (p_payload->>'day')::date; d jsonb; n int := 0; kept int := 0; v_status text; v_pf text;
begin
  select user_id into v_uid from sns_settings where ingest_key = p_key;
  if v_uid is null then raise exception 'invalid_key'; end if;
  if v_day is null then raise exception 'day required'; end if;
  if p_payload ? 'key_action' or p_payload ? 'summary' or p_payload ? 'report_md' then
    insert into sns_daily_reports as r (user_id, day, key_action, key_reason, summary, report_md, updated_at)
    values (v_uid, v_day, p_payload->>'key_action', p_payload->>'key_reason', p_payload->'summary', p_payload->>'report_md', now())
    on conflict (user_id, day) do update set key_action = coalesce(excluded.key_action, r.key_action), key_reason = coalesce(excluded.key_reason, r.key_reason),
      summary = coalesce(excluded.summary, r.summary), report_md = coalesce(excluded.report_md, r.report_md), updated_at = now();
  end if;
  for d in select * from jsonb_array_elements(coalesce(p_payload->'drafts', '[]'::jsonb)) loop
    continue when coalesce(d->>'body', '') = '' or (d->>'slot_at') is null;
    v_pf := coalesce(nullif(d->>'platform', ''), 'threads');
    select status into v_status from sns_drafts where user_id = v_uid and platform = v_pf and slot_at = (d->>'slot_at')::timestamptz;
    if v_status in ('approved', 'scheduled') then kept := kept + 1; continue; end if;
    insert into sns_drafts as s (user_id, platform, report_day, slot_at, role, experiment, body, self_reply, rationale, sources, status, status_note, scheduled_label,
      draft_kind, media, extra, updated_at)
    values (v_uid, v_pf, v_day, (d->>'slot_at')::timestamptz, d->>'role', d->>'experiment', d->>'body', d->>'self_reply', d->>'rationale', d->>'sources',
      coalesce(nullif(d->>'status', ''), 'draft'), d->>'status_note', d->>'scheduled_label', d->>'draft_kind', d->'media', d->>'extra', now())
    on conflict (user_id, platform, slot_at) do update set report_day = excluded.report_day, role = excluded.role, experiment = excluded.experiment,
      body = excluded.body, self_reply = excluded.self_reply, rationale = excluded.rationale, sources = excluded.sources,
      status = excluded.status, status_note = excluded.status_note, scheduled_label = excluded.scheduled_label,
      draft_kind = excluded.draft_kind, media = excluded.media, extra = excluded.extra, updated_at = now();
    n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'day', v_day, 'drafts', n, 'kept_approved', kept);
end $$;

create or replace function sns_drafts_approved(p_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid;
begin
  select user_id into v_uid from sns_settings where ingest_key = p_key;
  if v_uid is null then raise exception 'invalid_key'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'platform', platform, 'slot_at', slot_at, 'body', body, 'self_reply', self_reply,
      'role', role, 'draft_kind', draft_kind, 'media', media) order by slot_at)
    from sns_drafts where user_id = v_uid and status = 'approved'), '[]'::jsonb);
end $$;

revoke all on function sns_ingest_ig(uuid, jsonb) from public;
revoke all on function sns_media_key(uuid) from public;
grant execute on function sns_ingest_ig(uuid, jsonb) to anon, authenticated;
grant execute on function sns_media_key(uuid) to anon, authenticated;
grant execute on function sns_push_report(uuid, jsonb) to anon, authenticated;
grant execute on function sns_drafts_approved(uuid) to anon, authenticated;
