# Module: repository

The Data Repository, native in Postgres: sections → tables → columns (structure is data),
records, encrypted secrets, files in Drive. Tab **Repository**.

## Files

- Screen: `src/screens/Repository.tsx` (grid, header menus, record side panel, phone list,
  Monday import), `src/components/usePhone.ts`, `src/components/HostawayCheck.tsx` (§149).
- API: `repository.ts` (read), `repository-edit.ts`, `repository-structure.ts`,
  `repository-reveal.ts`, `repository-upload.ts`, `repository-import.ts`, `repository-check.ts` (§149),
  `google-drive.ts`, `google-callback.ts`.
- Server libs: `repo-store.ts`, `gdrive.ts`, `repository.ts` (old Apps Script API — only for the
  one-time import).
- Pure libs: `src/lib/repo.ts` (IDs, validation, `coerce`), `repo-import.ts` (Monday export parsing),
  `repo-checks.ts` (SECTIONS, CHECKS, runCheck, writePlan, composeRules/splitRules, draftAdds — §149, §155).
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
- **Archive** (§118): archived tables leave the sections and search (`loadMeta().archived`), and
  are listed under **Archive** at the foot of the list; opening one reads it read-only
  (`?op=list&archived=1`; every edit route still asks for a live table) with **↺ Restore**
  (`tables.restore`, brings its section back too). Archived 2026-10-09: Tools, STR Listings
  (STR Log ins was already archived).
- **Search** (§118): typing filters the open table; a bar offers **Search all tables for “…”**
  (highlighted when nothing here matches). Enter still works but is no longer the way in.
- SOP id 9 "Find, update and archive in the Data Repository" (screen `repository`).

- **Property type** (§138): select House / Apartment in the three Units tables (Houses, Cortland_Legacy,
  The Links), after Type (bedrooms). The inspection checklist reads it to decide house-only and apartment-only
  items — fill it for a new unit.

## Open items

- **Accounts & logins** (section `login`, reorganized 2026-10-09): three tables with the same
  columns — Name · (Unit, select, Unit services only) · Login URL · Username · Password 🔒 ·
  PIN / security code 🔒 · Account details · Notes:
  `booking_channels` (CHN, 17), `unit_services` (SVC, 15; AT&T rows tied to RG-1112/1214/1324/921),
  `company_tools` (TOOL, 32). Copied from **Tools** and **STR Listings** (now in the Archive),
  including Monday's two leftover rows (ROW-0036 has a password). Passwords
  were copied as ciphertext (never decrypted), audited as `secret.copy`; the plain-text PINs
  became secrets. Each record's Notes says where it came from. NEC, ineed and Gallery new portal
  login are marked "To review" in Company tools.
  2026-10-21: TOOL-0034…0060 (27) added from Monday's "Services" group (owner's screenshot) — passwords
  (and Roku's PIN) as secrets, Notes "Added from the Monday "Services" list". Mereo has no login yet;
  Austin Utilities is also in Unit services (SVC); Instacart / myQ URLs were cut off in the screenshot.
- The Units section also has a **STR Log ins** table — not part of this reorganization.

- **Units access/parking block (§147):** the three Units tables share one block, same keys, types
  and order after Type: `lock_type` (select: Schlage Smart Lock / Yale Smart Lock / Access Fob / Keys /
  None) · `keys_fobs` (Access Fob / None) · `cleaner_code` · `lockbox` · `closet_code` (houses: the
  supply closet in the house) · `has_closet` ("Has closet", 090: the unit keeps its supplies in its own closet — then
  `storage` names what REFILLS that closet; houses + The Links ✓, Cortland ✗) · `storage` (ref → `name` of the same table: **where the unit's supplies are
  kept** — a Storage row, or a house's OWN name = its closet; blank = ▲ no place. The inventory reads it and
  nothing else (§150); it is looked up in every Units table, but the ref picker offers only the same table —
  a central storage across buildings = repoint the ref or add its row) · `admin_code` 🔒 · `backup_code` 🔒 ·
  `parking` ("Parking notes") · `parking_free_street` · `parking_extra_price` ($/night, covered) ·
  `fob_replacement_fee` · and `lease_notes` after Status. Blank where it does not apply; the team
  fills it. Cleaners get only cleaner code, lockbox, fob (unit-access.ts); admin/backup are secrets.
  Since §150 the place (`storage`) and its code (a storage's closet code or lockbox; a house's `closet_code`) go to
  cleaners in step 2 of a clean, on the same rules as the door codes.
- Units tables still hold Wi-Fi and the account `password` columns as plain text (§66).
- **§148 filled:** Wi-Fi + `internet_account` (AT&T account #, after the Wi-Fi password) from the owner's
  list; `storage` = CORTLAND STORAGE S13 on every Cortland apartment (houses: blank, by design);
  `manager_contact` / `landlord_contact` (POC, after Maintenance #) for Napa Valley, Amber Valley,
  Timbercrest, Quest, Concord. Houses do not need the building block (floor, bldg, building link, lease
  portal) — their POC is the manager or landlord.

- **`?repo=<table>/<ROW-id>`** opens that record (Setup → Inventory's map links here, §150).
- **Check against Hostaway (§149, §155):** sidebar "⇄ Check against Hostaway" → five sections (House settings ·
  House description · House rules · Fees · Hostaway settings), viewed **One unit** (every field of a section) or
  **One field, all units**. Statuses ● same · ◐ capitals differ · ▲ different · ○ missing. Editors: per field
  "← Use Hostaway's" / "Send to Hostaway →", or a whole section ("← Copy all … from Hostaway" / "Send all … to
  Hostaway →") — **both ways confirmed with a Now → After box**. Hostaway writes: partial PUT, read back raw,
  before/after per field in `listing_text_changes`; Wi-Fi also refreshes `units.wifi_*`. Reads the RAW listings
  (`fetchListingsRaw`, hostaway.ts — every field; never sent to the browser whole). **A new check = one entry in
  `CHECKS`** (`src/lib/repo-checks.ts`: section, Repository column, Hostaway field name — read and written under
  the same name, `fee:<type>` = a custom fee in `listingFeeSetting` — and kind text/longtext/money/number/hour/
  bool/rules) + its column in the three Units tables with the section's name as `grp`. GET `repository`, POST
  `repository.edit`. Owner rule: Hostaway is right unless said otherwise; fill Repository from Hostaway first.
  - **Columns (079):** 50 per Units table, `grp` = the section. Hours are a select ("4 PM" ↔ Hostaway 16);
    Hostaway 1/0 ↔ checkbox. `cleaning_fee` moved into Fees; `password_2` is titled "Wifi password". Wi-Fi stays in
    Details, marked **⇄ sync** (cleaners get Hostaway's Wi-Fi on every sync); every other compared column is marked
    **⇄ button**: owner — nothing but Wi-Fi moves on its own; copy/send only by button, after before → after
    (the guest agent feeds on Hostaway, so not everything should go there). No Kaizen agent reads these columns.
  - **Composed texts = main + footer parts** (owner; `COMPOSED`): `house_rules` + every `rule_add_*` column
    and `description` + every `desc_add_*` column, appended as written (owner: never renumbered — the original
    order stays) in COLUMN order
    (`composeText`, order from `repo_columns.position`). Copying from Hostaway strips the record's parts off the end
    (`splitText`). A click on the text — the main cell, a part's cell, or the folded section — opens the pop-up
    (`ComposedEditor`): main text + each footer part (marked), "Whole text" as Hostaway gets it, "+ Add a footer
    part" = structure op `units.addPart` (new `<prefix><slug>` column in the three Units tables, after the last part).
    "✎ Draft the Adds" (`draftAdds`) words only EMPTY Adds and skips any the original rules already cover (pets,
    lost key/fob, extra guests). The fees' explanation for guests IS their Add.
  - **Hostaway settings** (`hw_*`) and the Insurance custom fee: copy-only (`send: false`), mapped for later.
  - **Drag to fill** (any table): the small handle at a cell's bottom-right, dragged down or up, copies its value
    into those rows (one save each, audited as usual). Not on the name column, secrets or documents.
  - **Grid sections:** any group other than Details folds into one column (▸ Fees · 10, cells "filled/total";
    House rules / House description show their whole text instead);
    click unfolds sideways, remembered per browser (`localStorage kaizen.repo.unfolded`). The record panel
    already shows groups as headings.
  - SOP 33 "Keep a unit's record and its Hostaway listing in step" — **draft**, for the owner to publish.

## Open items — Units data (owner, 2026-10-13; first two first)

1. **Admin / backup codes:** admin missing on Bobcat, Napa Valley, Timber Crest and the 8 P2; backup
   missing on every house and every P2. Amber Valley's admin "551" was probably "0551" (number column).
2. **Contracts (low):** lease, move-out date, leasing office hours, renewals, autopay, utilities,
   maintenance # — empty on most units.
3. **P2 storage:** decided (§150) — all 8 LP → "S1105 Storage (stock)"; houses → their own name (closet).
   Filled in production 2026-10-13 (audited as `storage (supplies place, §150)`).
4. **Closet codes (houses):** confirm Preston Vineyard / Napa Valley / Amber Valley, fill the rest.
5. **POC:** Preston Vineyard and Bobcat have none.
6. **Wi-Fi settled (§149):** Hostaway kept for CL2260, Preston Vineyard, Napa Valley, Concord and P2 1201/
   1406/4304/4308; P2-4315 fixed in Hostaway (4315WiFi). P2-4212 left as is (capitals differ: the owner's
   call). Bobcat has no guest cleaning fee in Hostaway.
7. **Parking and lost key/fob fee per house** — no rush.
8. **Sections filled (§155), every active unit** (2026-10-13, owner: "llena todas"): empty fields copied from
   Hostaway (82+1 copies; nothing that already had a value was overwritten). Check after: 827 same, 179 empty on
   both, 2 left on purpose — P2-4212 Wi-Fi (capitals, owner's call) and Preston Vineyard's House rules (Kaizen has
   its duplicates removed — rule 13's lost-fob sentence; pet and fob Adds cleared — and the extra-guests Add;
   not sent to Hostaway). The other units' rules use the same template: rules 13 and 16 likely repeat there too.
- The old Apps Script link/key in Settings can be cleared now the import is confirmed.

## History

§63 (read-only era), §66 (superseded), §71, §72, §74, §80, §118, §138, §147, §148, §149, §150, §155.

## Redesign (§158, 2026-10-14, branch `redesign`)

UI only; tokens and shared components from `docs/design-system.md`.
- A select option's colour (`.rb-pill.cN`) is a category, not a state: the pill is neutral and the colour is a
  7 px dot. "Second" in red / "First" in green read as failure / confirmed next to the real states.
  The `--pillN-*` tokens stay (the dot uses the `-fg` step).
- Phone: search and reload share a row under the title (reload sat alone on a row); the record list has a surface.
- The app shell's sticky header is now `header.app-header`: it had also caught `.rb-bar` and `.rb-panel-head`
  (and Home's / the field pages' headers) mid-redesign; they keep the plain header they always had.
