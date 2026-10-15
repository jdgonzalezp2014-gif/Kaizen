# Module: guests (agreement, ID, documents)

Every guest signs the rental agreement and gives an ID through Hostaway's guest portal;
Kaizen shows where each arrival stands and keeps a copy in Drive for buildings that need it
(the P2 building today).

## Files

- `src/screens/Home.tsx` (Check-ins card: docChip, DropRow drag-and-drop, upload),
  Operations board arrivals, Operations → Setup → "Guest documents — copy in Drive".
- API: `guest-docs.ts` (list folders/files), `guest-docs-upload.ts`, `operations.ts`
  (agreement/ID flags on arrivals), `google-drive.ts` / `google-callback.ts` (OAuth).
- Server libs: `guest-docs.ts` (folder path, docName), `gdrive.ts` (Drive client, resumable upload).
- Script: `scripts/house-rules-id-notice.mjs` (ID notice appended to house rules; `--dry` first).

## Tables

`accounts.guest_docs_root_id`, `accounts.guest_docs_units` (listing ids that keep a copy),
`drive_folders` (folder id address book), `listing_text_changes` (house-rules edits, revertible),
Drive OAuth tokens on `accounts` (encrypted).

## Rules that bite

- Folders are the daily file's, found by name, never moved:
  `Reservations / YYYY / YYYY-MM / YYYY-MM-DD / "MMM d & First Last" / ID | Rental Agreement` (§73).
- The upload finds the folder from **Hostaway's** record of the stay, not the browser's (§73).
- Agreement status from Hostaway (`reservationAgreement`); "ID verified" only when Hostaway
  says so — an ID uploaded in the portal is not "verified", and the API exposes no file, so
  the Drive copy is manual: download from Hostaway, drop it on the arrival (§89, §90, §106).
- Home: ⇪ ID / ⇪ Agreement to pick, or drag a file over an arrival → "Drop as ID / Drop as
  Agreement"; ✓ opens the folder; amber only where the building keeps a copy (§106).
- Which units keep a copy is a setting per building, not a rule (Airbnb limits asking) (§73).
- Permission `guests.documents` (the most sensitive data Kaizen holds).
- New listings reach `units` on their own when the board sees them (§90).

## Open items

- The external guest-identification sheet the P2 building reads is still written by the
  daily file (`18 guestidsync.js`) — not moved; ask before touching it.

## History

§72, §73, §89, §90, §106.

## Redesign (§158, 2026-10-14, branch `redesign`)

UI only; tokens and shared components from `docs/design-system.md`.
- Home → Check-ins: the "⇪ ID / ⇪ Agreement" uploads were a `<label>` over an `<input hidden>` — not reachable
  by keyboard, and a 13 px word to tap. Now the input is visually hidden but focusable (`.sr-file`, focus ring
  on the label) and the label is a dashed pill (amber when the building needs the copy, muted when optional),
  36 px tall on a phone. Drag-and-drop on the row is unchanged.
- Signed / Not signed / ID verified already carried a word + shape; unchanged.

## Home check-ins/outs rows (2026-10-15)

Owner: same logic as Movements, two lines a row. Check-out: unit BR / cleaner · pay (small) | flags in one row.
Check-in: unit BR / guest ↗ · nights · guests | pills: the agreement pill only (`✓ signed` solid green, `▲ not signed`
dashed amber — clickable to upload the agreement when the person has `guests.documents`), plus `○ ID` only where the
building keeps an ID copy (as on the board). "✓ ID verified" and the separate Agreement chip are gone from Home.
"Open the board" sits top right; the panel's summary goes under the title.
