-- SNS 데일리 리포트 (Threads) 스키마
-- running-calendar Supabase 프로젝트에 sns_ 접두어 테이블로 추가 (같은 계정으로 로그인)

create table if not exists sns_settings (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  ingest_key uuid not null default gen_random_uuid() unique,
  threads_handle text,
  last_ingest_at timestamptz,
  last_ingest_note text,
  created_at timestamptz default now()
);

create table if not exists sns_account_daily (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  platform text not null default 'threads',
  day date not null,
  handle text,
  followers int,            -- 프로필 기준 실시간 팔로워 수
  insights_followers int,   -- 인사이트 화면 기준 (하루~이틀 지연)
  views_7d int, viewers_7d int, reactions_7d int, net_followers_7d int,
  views_30d int, viewers_30d int, reactions_30d int, net_followers_30d int,
  follower_viewers_7d int, nonfollower_viewers_7d int,
  raw jsonb,
  collected_at timestamptz default now(),
  primary key (user_id, platform, day)
);

create table if not exists sns_posts (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  platform text not null default 'threads',
  code text not null,
  handle text,
  posted_at timestamptz,
  text text,
  views int, viewers int, profile_visits int, follows int,
  likes int, replies int, reposts int, quotes int, shares int,
  like_rate numeric, reply_rate numeric, share_rate numeric, quote_rate numeric, repost_rate numeric,
  top_sources text,
  updated_at timestamptz default now(),
  primary key (user_id, platform, code)
);
create index if not exists sns_posts_posted_idx on sns_posts (user_id, posted_at desc);

create table if not exists sns_post_snapshots (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  platform text not null default 'threads',
  code text not null,
  day date not null,
  views int, likes int, replies int, reposts int, profile_visits int, follows int,
  collected_at timestamptz default now(),
  primary key (user_id, platform, code, day)
);

create table if not exists sns_tracked (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  handle text not null,
  note text,
  created_at timestamptz default now(),
  primary key (user_id, handle)
);

create table if not exists sns_tracked_daily (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  handle text not null,
  day date not null,
  followers int,
  full_name text,
  recent_posts jsonb,
  collected_at timestamptz default now(),
  primary key (user_id, handle, day)
);

-- RLS: 본인 행만
do $$
declare t text;
begin
  foreach t in array array['sns_settings','sns_account_daily','sns_posts','sns_post_snapshots','sns_tracked','sns_tracked_daily'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists own_all on %I', t);
    execute format('create policy own_all on %I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

-- 확장 프로그램 설정 조회 (수집 키로 인증)
create or replace function sns_ext_config(p_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid; v_handle text; v_last timestamptz;
begin
  select user_id, threads_handle, last_ingest_at into v_uid, v_handle, v_last from sns_settings where ingest_key = p_key;
  if v_uid is null then raise exception 'invalid_key'; end if;
  return jsonb_build_object(
    'handle', v_handle,
    'last_ingest_at', v_last,
    'tracked', coalesce((select jsonb_agg(handle order by created_at) from sns_tracked where user_id = v_uid), '[]'::jsonb),
    'known_posts', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'posted_at', posted_at, 'updated_at', updated_at))
                             from sns_posts where user_id = v_uid and posted_at > now() - interval '120 days'), '[]'::jsonb)
  );
end $$;

-- 확장 프로그램 데이터 수신 (수집 키로 인증)
create or replace function sns_ingest(p_key uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
  v_day date := coalesce((p_payload->>'day')::date, (now() at time zone 'Asia/Seoul')::date);
  v_handle text := nullif(p_payload->>'handle', '');
  a jsonb; p jsonb; t jsonb;
  n_posts int := 0; n_tracked int := 0;
begin
  select user_id into v_uid from sns_settings where ingest_key = p_key;
  if v_uid is null then raise exception 'invalid_key'; end if;

  a := p_payload->'account';
  if a is not null and jsonb_typeof(a) = 'object' then
    insert into sns_account_daily as d (user_id, platform, day, handle, followers, insights_followers,
      views_7d, viewers_7d, reactions_7d, net_followers_7d, views_30d, viewers_30d, reactions_30d, net_followers_30d,
      follower_viewers_7d, nonfollower_viewers_7d, raw, collected_at)
    values (v_uid, 'threads', v_day, v_handle, (a->>'followers')::int, (a->>'insights_followers')::int,
      (a->>'views_7d')::int, (a->>'viewers_7d')::int, (a->>'reactions_7d')::int, (a->>'net_followers_7d')::int,
      (a->>'views_30d')::int, (a->>'viewers_30d')::int, (a->>'reactions_30d')::int, (a->>'net_followers_30d')::int,
      (a->>'follower_viewers_7d')::int, (a->>'nonfollower_viewers_7d')::int, a->'raw', now())
    on conflict (user_id, platform, day) do update set
      handle = coalesce(excluded.handle, d.handle),
      followers = coalesce(excluded.followers, d.followers),
      insights_followers = coalesce(excluded.insights_followers, d.insights_followers),
      views_7d = coalesce(excluded.views_7d, d.views_7d), viewers_7d = coalesce(excluded.viewers_7d, d.viewers_7d),
      reactions_7d = coalesce(excluded.reactions_7d, d.reactions_7d), net_followers_7d = coalesce(excluded.net_followers_7d, d.net_followers_7d),
      views_30d = coalesce(excluded.views_30d, d.views_30d), viewers_30d = coalesce(excluded.viewers_30d, d.viewers_30d),
      reactions_30d = coalesce(excluded.reactions_30d, d.reactions_30d), net_followers_30d = coalesce(excluded.net_followers_30d, d.net_followers_30d),
      follower_viewers_7d = coalesce(excluded.follower_viewers_7d, d.follower_viewers_7d),
      nonfollower_viewers_7d = coalesce(excluded.nonfollower_viewers_7d, d.nonfollower_viewers_7d),
      raw = coalesce(excluded.raw, d.raw), collected_at = now();
  end if;

  for p in select * from jsonb_array_elements(coalesce(p_payload->'posts', '[]'::jsonb)) loop
    continue when coalesce(p->>'code', '') = '';
    insert into sns_posts as s (user_id, platform, code, handle, posted_at, text, views, viewers, profile_visits, follows,
      likes, replies, reposts, quotes, shares, like_rate, reply_rate, share_rate, quote_rate, repost_rate, top_sources, updated_at)
    values (v_uid, 'threads', p->>'code', v_handle, (p->>'posted_at')::timestamptz, p->>'text',
      (p->>'views')::int, (p->>'viewers')::int, (p->>'profile_visits')::int, (p->>'follows')::int,
      (p->>'likes')::int, (p->>'replies')::int, (p->>'reposts')::int, (p->>'quotes')::int, (p->>'shares')::int,
      (p->>'like_rate')::numeric, (p->>'reply_rate')::numeric, (p->>'share_rate')::numeric, (p->>'quote_rate')::numeric, (p->>'repost_rate')::numeric,
      p->>'top_sources', now())
    on conflict (user_id, platform, code) do update set
      handle = coalesce(excluded.handle, s.handle), posted_at = coalesce(excluded.posted_at, s.posted_at),
      text = coalesce(excluded.text, s.text), views = coalesce(excluded.views, s.views), viewers = coalesce(excluded.viewers, s.viewers),
      profile_visits = coalesce(excluded.profile_visits, s.profile_visits), follows = coalesce(excluded.follows, s.follows),
      likes = coalesce(excluded.likes, s.likes), replies = coalesce(excluded.replies, s.replies), reposts = coalesce(excluded.reposts, s.reposts),
      quotes = coalesce(excluded.quotes, s.quotes), shares = coalesce(excluded.shares, s.shares),
      like_rate = coalesce(excluded.like_rate, s.like_rate), reply_rate = coalesce(excluded.reply_rate, s.reply_rate),
      share_rate = coalesce(excluded.share_rate, s.share_rate), quote_rate = coalesce(excluded.quote_rate, s.quote_rate),
      repost_rate = coalesce(excluded.repost_rate, s.repost_rate), top_sources = coalesce(excluded.top_sources, s.top_sources),
      updated_at = now();
    if (p->>'views') is not null then
      insert into sns_post_snapshots as ps (user_id, platform, code, day, views, likes, replies, reposts, profile_visits, follows, collected_at)
      values (v_uid, 'threads', p->>'code', v_day, (p->>'views')::int, (p->>'likes')::int, (p->>'replies')::int, (p->>'reposts')::int,
        (p->>'profile_visits')::int, (p->>'follows')::int, now())
      on conflict (user_id, platform, code, day) do update set views = excluded.views, likes = excluded.likes, replies = excluded.replies,
        reposts = excluded.reposts, profile_visits = excluded.profile_visits, follows = excluded.follows, collected_at = now();
    end if;
    n_posts := n_posts + 1;
  end loop;

  for t in select * from jsonb_array_elements(coalesce(p_payload->'tracked', '[]'::jsonb)) loop
    continue when coalesce(t->>'handle', '') = '' or (t->>'followers') is null;
    insert into sns_tracked_daily as td (user_id, handle, day, followers, full_name, recent_posts, collected_at)
    values (v_uid, lower(t->>'handle'), v_day, (t->>'followers')::int, t->>'full_name', t->'recent_posts', now())
    on conflict (user_id, handle, day) do update set followers = excluded.followers,
      full_name = coalesce(excluded.full_name, td.full_name), recent_posts = coalesce(excluded.recent_posts, td.recent_posts), collected_at = now();
    n_tracked := n_tracked + 1;
  end loop;

  update sns_settings set last_ingest_at = now(),
    threads_handle = coalesce(v_handle, threads_handle),
    last_ingest_note = left(coalesce(p_payload->>'note', ''), 500)
  where user_id = v_uid;

  return jsonb_build_object('ok', true, 'day', v_day, 'posts', n_posts, 'tracked', n_tracked);
end $$;

revoke all on function sns_ingest(uuid, jsonb) from public;
revoke all on function sns_ext_config(uuid) from public;
grant execute on function sns_ingest(uuid, jsonb) to anon, authenticated;
grant execute on function sns_ext_config(uuid) to anon, authenticated;
