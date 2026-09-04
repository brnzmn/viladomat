# apps/web

Next.js (App Router) front end: sign-in with a second factor, community context, bulk upload with
client-side hashing, seed & governance forms, and read-only lists of documents and findings. Later
screens (grouping, bank, works, vendors, requests & reports) render a placeholder until their
milestone.

The browser only ever holds the anon key and the user's session; every read and write goes through
row-level security. The `restricted` schema is never touched from here.

## Setup

```bash
pnpm install                                   # from the repository root
cp apps/web/.env.example apps/web/.env.local   # fill in NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY
pnpm --filter web dev                          # http://localhost:3000
```

Accounts are created by the operator in the Supabase dashboard (or `vx` once available); sign-up
is disabled. After the first sign-in the app requires a TOTP authenticator to be enrolled before any
other screen is reachable; every later session must pass the challenge before any screen loads.
Membership rows in `public.community_members`
decide which community a user sees and whether they may write (`owner_reviewer`,
`second_reviewer`) or only read (`viewer`, `auditor_readonly`).

Supabase Storage must expose the resumable (TUS) endpoint; the bulk upload sends 6 MB chunks to
`<SUPABASE_URL>/storage/v1/upload/resumable` into the private `originals` bucket with `x-upsert: false`.

## Checks

```bash
pnpm --filter web typecheck   # next typegen + tsc --noEmit
pnpm --filter web lint        # eslint (flat config, eslint-config-next)
pnpm --filter web build       # needs the two NEXT_PUBLIC_* variables (placeholders are fine)
pnpm neutrality               # repository-wide wording guard
```

## Database types

`lib/database.types.ts` is hand-written for the tables, views, functions and enums the app uses,
in the shape `supabase gen types` produces. Regenerate it whenever those objects change:

```bash
npx supabase@latest gen types typescript \
  --db-url postgresql://postgres:postgres@localhost:54329/viladomat --schema public \
  > apps/web/lib/database.types.ts
```

(The CLI needs Docker to run `postgres-meta`; if that is not available, edit the file by hand.)

## Layout

```
proxy.ts                 session refresh + route gates (login, MFA step-up)
lib/supabase/            browser / server / proxy clients
lib/community.ts         community context (cookie vx_community) and role helpers
lib/audit.ts             log_access RPC wrapper (every seed write is logged before/after)
app/login, app/mfa       password sign-in, TOTP enrol / verify
app/communities          community picker
app/(app)/               authenticated shell: nav, header, confidentiality banner
app/(app)/seed           tabs with create/edit forms (server actions + zod)
app/(app)/upload         bulk upload client (SHA-256, EXIF, TUS, files + jobs rows)
app/(app)/documents      read-only list with filters
app/(app)/findings       read-only list with filters
```

Deployed to Vercel in region `fra1` (`vercel.json`).
