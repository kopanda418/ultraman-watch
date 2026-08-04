-- ピック・アーカイブ共有用テーブル。Supabase の SQL Editor に貼って実行してください。
-- PostgREST が自動で API を生やすため、サーバーコードは書きません。
-- 何度貼り直しても同じ結果になるように書いてあります。

create table if not exists public.picks (
  id           text primary key,        -- 収集側で採番した記事 ID をそのまま使う
  url          text not null,
  title        text not null,
  summary      text,
  source_name  text,
  event_date   date,
  prefectures  text[],
  is_kanto     boolean default false,
  picked_by    text,                    -- 誰がピックしたか（表示用）
  picked_at    timestamptz default now()
);

-- 行レベルセキュリティ。有効にしないと anon キーだけで誰でも書けてしまう。
alter table public.picks enable row level security;

-- このプロジェクトは既存の別アプリと共用しているため、
-- 「認証済みなら誰でも」ではなく本人・配偶者の UID だけを明示的に許可する。
create or replace function public.is_ultraman_watch_family()
returns boolean
language sql stable
as $$
  select auth.uid() in (
    '4213126d-660a-481f-bb4a-72c42c25664b',
    '7c506286-c179-4817-9fdf-b7282609ad47'
  );
$$;

drop policy if exists "認証済みユーザーは閲覧できる" on public.picks;
drop policy if exists "認証済みユーザーは追加できる" on public.picks;
drop policy if exists "認証済みユーザーは削除できる" on public.picks;

drop policy if exists "家族のみ閲覧できる" on public.picks;
create policy "家族のみ閲覧できる"
  on public.picks for select to authenticated using (public.is_ultraman_watch_family());

drop policy if exists "家族のみ追加できる" on public.picks;
create policy "家族のみ追加できる"
  on public.picks for insert to authenticated with check (public.is_ultraman_watch_family());

drop policy if exists "家族のみ削除できる" on public.picks;
create policy "家族のみ削除できる"
  on public.picks for delete to authenticated using (public.is_ultraman_watch_family());

-- 相手がピックした瞬間に自分の画面へ反映させる（任意）
--
-- supabase_realtime はプロジェクト全体で共有している設定なので、扱いに注意する。
-- 表を「足す」だけで他アプリの分を消しはしないため影響は無いが、
-- 既に入っている表をもう一度足すとエラーになり、そこで実行が止まる。
-- 貼り直せるように、重複だけ握りつぶす。
do $$ begin
  alter publication supabase_realtime add table public.picks;
exception when duplicate_object then null;
end $$;

-- ── アーカイブ ──────────────────────────────────────────
-- 「もう見た・興味がない」として一覧から外した記事。2人で共有する。
-- 記事の中身も一緒に持つのはピックと同じ理由に加えて、アーカイブしたものは
-- items.json の保持上限を超えたときに真っ先に消える側だから。ID だけ持つ作りだと
-- 消えた時点でアーカイブタブから中身が見えなくなる。
create table if not exists public.archives (
  id           text primary key,        -- 収集側で採番した記事 ID をそのまま使う
  url          text not null,
  title        text not null,
  summary      text,
  source_name  text,
  event_date   date,
  prefectures  text[],
  is_kanto     boolean default false,
  archived_by  text,                    -- 誰がアーカイブしたか（表示用）
  archived_at  timestamptz default now()
);

alter table public.archives enable row level security;

drop policy if exists "家族のみ閲覧できる" on public.archives;
create policy "家族のみ閲覧できる"
  on public.archives for select to authenticated using (public.is_ultraman_watch_family());

drop policy if exists "家族のみ追加できる" on public.archives;
create policy "家族のみ追加できる"
  on public.archives for insert to authenticated with check (public.is_ultraman_watch_family());

drop policy if exists "家族のみ削除できる" on public.archives;
create policy "家族のみ削除できる"
  on public.archives for delete to authenticated using (public.is_ultraman_watch_family());

-- 相手がアーカイブした瞬間に自分の画面へ反映させる（重複時の扱いは picks と同じ）
do $$ begin
  alter publication supabase_realtime add table public.archives;
exception when duplicate_object then null;
end $$;

-- ── 開催日の手直し ──────────────────────────────────────
-- 自動で読み取った開催日が違う・取れなかったときに、利用者が入れ直した値。
-- 記事そのものではなく日付だけを持つ。2人で共有する。
create table if not exists public.event_dates (
  id             text primary key,      -- 収集側で採番した記事 ID
  event_date     date,                  -- 開始日。null は「日程未定に戻す」
  event_end_date date,                  -- 終了日。開始日だけのときは null
  edited_by      text,
  edited_at      timestamptz default now()
);

alter table public.event_dates enable row level security;

drop policy if exists "家族のみ閲覧できる" on public.event_dates;
create policy "家族のみ閲覧できる"
  on public.event_dates for select to authenticated using (public.is_ultraman_watch_family());

drop policy if exists "家族のみ追加できる" on public.event_dates;
create policy "家族のみ追加できる"
  on public.event_dates for insert to authenticated with check (public.is_ultraman_watch_family());

drop policy if exists "家族のみ更新できる" on public.event_dates;
create policy "家族のみ更新できる"
  on public.event_dates for update to authenticated using (public.is_ultraman_watch_family())
  with check (public.is_ultraman_watch_family());

drop policy if exists "家族のみ削除できる" on public.event_dates;
create policy "家族のみ削除できる"
  on public.event_dates for delete to authenticated using (public.is_ultraman_watch_family());

do $$ begin
  alter publication supabase_realtime add table public.event_dates;
exception when duplicate_object then null;
end $$;

-- ── 収集スクリプトへ渡す窓 ──────────────────────────────
-- 収集スクリプト（GitHub Actions）は、保持上限を超えた分をアーカイブ済みから
-- 先に落とすために「どの記事がアーカイブされたか」だけを知る必要がある。
-- そのためだけの読み取り専用のビュー。記事IDしか返さないので、
-- 表示名も記事の中身も外へ出ない。書き込みも一切できない。
--
-- security_invoker = false（既定）なので、ビューは所有者の権限で動く。
-- おかげで archives 本体の行レベルセキュリティは2人に閉じたまま据え置ける。
-- この2点のどちらかを崩すと、アーカイブの中身まで公開されるので注意。
drop view if exists public.archived_ids;
create view public.archived_ids with (security_invoker = false) as
  select id from public.archives;

-- anon キーは公開されているため、ここから読めるのは意味を持たない ID の列だけ。
grant select on public.archived_ids to anon;

-- 手直しした開催日も収集側へ渡す。渡さないと、次の収集で自動読み取りの値に
-- 戻ってしまい、日付を入れた記事が保持期間の判定で消えることもある。
-- 誰が直したかは渡さない。ID と日付だけ。
drop view if exists public.edited_event_dates;
create view public.edited_event_dates with (security_invoker = false) as
  select id, event_date, event_end_date from public.event_dates;

grant select on public.edited_event_dates to anon;
