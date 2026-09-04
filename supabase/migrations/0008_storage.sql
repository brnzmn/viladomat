-- 0008_storage.sql
-- Buckets and object policies. Object keys start with the community id:
--   originals/<community_id>/<sha2>/<sha256>.<ext>   (immutable; no update/delete policies)
--   derived/<community_id>/<sha256>/p<n>_<w>x<h>.jpg  (worker-written; members read)
--   exports/<community_id>/...                        (packs, manifests, legal sources)

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('originals', 'originals', false, 524288000, array['image/jpeg','image/png','image/heic','image/heif','image/webp','image/tiff','application/pdf','message/rfc822','text/plain','text/csv','application/octet-stream']),
  ('derived', 'derived', false, 52428800, null),
  ('exports', 'exports', false, 524288000, null)
on conflict (id) do nothing;

-- first path segment is the community id
create or replace function public.object_community(name text)
returns uuid language sql immutable as $$
  select case when (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$' then (storage.foldername(name))[1]::uuid end
$$;

-- originals: reviewers upload; originals visible to reviewers/viewers; never updated or deleted by clients
create policy originals_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'originals' and public.is_reviewer(public.object_community(name)));
create policy originals_select on storage.objects for select to authenticated
  using (bucket_id = 'originals' and public.can_see_originals(public.object_community(name)));

-- derived: worker writes with the service role; reviewers may also write crops; members read
create policy derived_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'derived' and public.is_reviewer(public.object_community(name)));
create policy derived_update on storage.objects for update to authenticated
  using (bucket_id = 'derived' and public.is_reviewer(public.object_community(name)));
create policy derived_select on storage.objects for select to authenticated
  using (bucket_id = 'derived' and public.is_member(public.object_community(name)));

-- exports: reviewers write; members read
create policy exports_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'exports' and public.is_reviewer(public.object_community(name)));
create policy exports_select on storage.objects for select to authenticated
  using (bucket_id = 'exports' and public.is_member(public.object_community(name)));
