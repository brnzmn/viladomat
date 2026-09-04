# Seed files

`vx seed <file.yaml>` loads hand-transcribed governance data so the calendar, document matrix,
verbatim minutes quotations and the first rules run on day one, before any extraction exists.

- `example.yaml` — the structure, with community-level figures transcribed from the March 2023
  ordinary meeting minutes (page references included). Fill in what is missing; never add a
  person's name. Units are identified by their label; officers only by role.
- `local/` — private working copies (git-ignored).

Workflow:

```bash
pnpm vx seed seed/example.yaml --dry-run          # validate
pnpm vx seed seed/example.yaml --owner-user <auth user id>   # load; registers you as owner_reviewer
pnpm vx rules                                      # D0/D5/D6/E5/E6/E7/E8 on the seeded data
pnpm vx report --pack pre-junta --lang es          # pre-junta pack v0 (HTML + PDF)
```

Re-running `vx seed` updates existing rows by their natural keys (unit label, meeting date +
type, resolution item, works package code + label, derrama object). Rows that extraction later
supersedes are changed only through `field_revisions`, so the seed origin stays visible.

Every meeting can be marked "verified against the page" in the web app (Seed & governance); the
pre-junta pack prints which figures are still pending that check.
