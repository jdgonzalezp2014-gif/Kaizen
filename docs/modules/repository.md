# Module: repository

The Data Repository, native in Postgres: sections → tables → columns (structure is data),
records, encrypted secrets, files in Drive. Tab **Repository**.

## Files

- Screen: `src/screens/Repository.tsx` (grid, header menus, record side panel, phone list,
  Monday import), `src/components/usePhone.ts`.
- API: `repository.ts` (read), `repository-edit.ts`, `repository-structure.ts`,
  `repository-reveal.ts`, `repository-upload.ts`, `repository-import.ts`,
  `google-drive.ts`, `google-callback.ts`.
- Server libs: `repo-store.ts`, `gdrive.ts`, `repository.ts` (old Apps Script API — only for the
  one-time import).
- Pure libs: `src/lib/repo.ts` (IDs, validation, `coerce`), `repo-import.ts` (Monday export parsing).
- Script: `scripts/import-repository.mjs` (`npm run import:repository`, `--dry`, `--replace`).

## Tables

`repo_sections`, `repo_tables`, `repo_columns`, `repo_records` (JSONB `vals`, `seq` IDs never
reused, archived not deleted), `repo_secrets` (AES-GCM, never in vals/lists/search),
`repo_files` (links; `drive_file_id`), `repo_reveals`, `repo_audit`; Drive OAuth on `accounts`.

## Rules that bite

- Secrets are masked everywhere; a reveal is logged **before** it decrypts and re-masks after
  30 s; a masked value sent back is refused (§66, §71).
- Validation on the fields a save **writes** (old data predates the rules) (§71).
- Deleting a column erases its values (typed name to confirm, audit keeps what was erased —
  never a secret); deleting a table archives it; secret/reference/document columns keep
  their type (§71).
- Files live in Drive (8 TB), via one OAuth connection (full `drive` scope); folders
  section → table → record → document column; uploads ≤ 50 MB through the Worker, resumable;
  removal = Drive trash; every action in `repo_audit` under the person's name (§72).
- Monday import: groups → a Group column, repeated headers dropped, password-like columns
  proposed as secret (§74).
- Permissions: `repository`, `repository.edit`, `repository.structure`, reveal.
- Phone: a list; a tap opens the record full screen (§80).

## Open items

- Units tables hold door codes / Wi-Fi as plain columns; only Login → Tools → password is a
  secret. Fix = new secret column + copy + remove old (owner's call) (§66).
- The old Apps Script link/key in Settings can be cleared now the import is confirmed.

## History

§63 (read-only era), §66 (superseded), §71, §72, §74, §80.
