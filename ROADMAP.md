# OCR Contact Tracker — Roadmap Checklist

Everything built so far, checked off, organized by phase. Unchecked items are genuinely outstanding, not just implied.

## Phase 0 — Planning
- [x] Requirements locked: open add/edit for members, admin-gated delete
- [x] Stack locked: HTML/CSS/JS + Supabase + Vercel, free tier
- [x] Domain locked: ocr-tracker.vercel.app

## Phase 1 — Foundation
- [x] Supabase project, GitHub repo, Vercel deploy pipeline
- [x] contacts table + RLS policies, tested end-to-end with curl
- [x] Shared admin login (Supabase Auth)
- [x] Add-contact form
- [x] Dashboard: search, sort, click-to-expand detail rows
- [x] Reminder status coloring (overdue / soon / upcoming) + follow-ups filter
- [x] Admin login/logout, delete gated to admins
- [x] Loading states, network-resilient error handling
- [x] Mobile responsiveness, iOS zoom-on-focus fix

## Phase 2 — Schema & Feature Expansion
- [x] Point person (label), phone, faith background, interests (Event/LG/Church toggles)
- [x] Suggested connection, progress notes (renamed from "other")
- [x] Edit capability opened to all members, not just admins
- [x] Interest fields as sliding toggle switches

## Phase 3 — Visual Identity
- [x] Sticky top bar, terracotta accent, Anton/Poppins fonts
- [x] Real OCR branding integrated once assets arrived
- [x] Safe logo fallback pattern (text wordmark, never a broken image)

## Phase 4 — Containerization
- [x] campuses + seasons tables, branding Storage bucket
- [x] campuses.html hub page
- [x] seasons.html per-campus history, "Current" badge (auto-latest)
- [x] Background/logo cascading (campus → seasons page, season → tracker)
- [x] Independent background override per level
- [x] Admin-only create/edit via pencil-icon buttons
- [x] Breadcrumb navigation across all three pages
- [x] Wide squircle banner card redesign

## Phase 5 — Dark Mode & Polish
- [x] Shared theme.js, system-preference default, persists choice
- [x] Monochrome sliding theme toggle
- [x] Form inputs always white; page chrome follows theme
- [x] Apple-style rounding pass across buttons/dialogs/fields

## Phase 6 — Calendar
- [x] flatpickr replacing native date input
- [x] Typed multi-format date parsing
- [x] Fixed dialog top-layer conflict (moved off native showModal())

## Phase 7 — Public & Fast-Entry Tools
- [x] signup.html — public guest form, no login, season-branded, zero internal links
- [x] Optional "not from one of these schools" note on signup.html
- [x] source column (member / online), Online Sign-ups / In Person / All tabs
- [x] "Unconnected" badge next to a contact's name when their connector is blank, or free text like "Instagram"/"social media"/etc. (`NON_PERSON_CONNECTOR_KEYWORDS` in index.html) — flags people who found OCR organically rather than through a specific member, so the team can spot who still needs a real point person assigned.
- [x] quick-add.html — URL-first + localStorage fallback, remembers point person, quick note field

## Phase 8 — Cross-Campus Support
- [x] Campus dropdown on tracker add/edit form + Quick Add
- [x] "Other (not listed)" option — note only, doesn't change routing
- [x] Dedicated admin-only Transfer button, auto-prepended note on transfer
- [x] Fixed critical bug: tracker had no season_id filter at all (showed every contact from every season)
- [x] Fixed critical bug: new contacts weren't being tagged with season_id at all

## Phase 9 — Delete Safety
- [x] Campus/season delete blocked while non-empty (contacts/seasons still inside)
- [x] Admin re-authentication (email + password) required to confirm any delete
- [x] Fixed: campuses/seasons had no delete RLS policy at all (silent no-op deletes)

## Phase 10 — Data Visibility
- [x] contacts_with_campus view (campus visible per-contact without a denormalized column)
- [x] Renamed the view after an initial typo
- [x] security_invoker = true set (views bypass RLS by default otherwise)

## Phase 11 — Three-Tier Auth
- [x] is_admin() helper function reading a tamper-proof app_metadata flag
- [x] Tracker fully gated behind a real login screen (not just hidden buttons)
- [x] All RLS policies rewritten: public (insert-only) / member (view+edit) / admin (everything)
- [x] Admin account flagged via SQL merge (not overwritten)
- [x] Shared member account created (admin-created, not self-service, deliberately)
- [x] Fixed two separate duplicate-dialog-ID bugs found during this rework
- [x] Fixed Cancel buttons leaving the page unclickable (backdrop not being removed)

## Phase 12 — Animations
- [x] Shared loading.js, pulsing OCR wordmark, visible-by-default (no flash)
- [x] Loader shown on click-to-navigate, hidden once each page is ready
- [x] Fail-safe: wrapped in try/finally so it can never get stuck
- [x] Actual card-swell click animation (separate from the page loader)
- [x] Button press-down feedback on every button
- [x] Dialog pop-in/pop-out entrance and exit animation
- [x] Timing fix for the delete flow's two-dialog handoff

## Roadmap v2 — campus-scoped access, export/import (in progress)

Everything above was the original single-tier build. This section tracks the
follow-on work: real per-campus accounts, data export/import, and the small
features that came up along the way. Organized by the same phases from the
Roadmap v2 planning doc.

### Phase 0 — Quick wins
- [x] Follow-up ownership field (current / suggested / other point person)
- [x] Phone / WeChat field revamp (`type="text"`, relabeled)
- [x] In-app calendar view (agenda + month grid, reminder-date based)

### Phase 1 — Campus-scoped access control
- [x] Three real tiers: `dev` / `campus_admin` / `member`, tagged via `app_metadata.role` + `app_metadata.campus_id`
- [x] `is_dev()`, `is_campus_admin()`, `get_user_campus_id()`, `season_campus_id()` helper functions
- [x] RLS rewritten on `contacts`/`campuses`/`seasons` to scope by campus, not just role
- [x] PolyU and CityU each have their own member + campus_admin accounts; dev account separate from both
- [x] `index.html` admin check fixed (was still checking the old shared `role === "admin"`, silently excluding `dev`/`campus_admin`)
- [x] `campuses.html`/`seasons.html` button gating tightened — `campus_admin` sees only their own campus's edit/create controls, not every campus's
- [x] **Access Denied page** — a member/campus_admin who lands on a season belonging to a different campus (e.g. via a stale or hand-edited URL) sees a clear "you don't have access" screen instead of a misleadingly empty dashboard. Fixed a follow-up bug where the check trusted the URL's `?campus=` param over the season's real campus, causing false positives on legitimate same-campus links.
- [x] **Transfer**, extended to `campus_admin` — RLS `WITH CHECK` loosened so a campus_admin can move a contact into another campus's season (the `USING` clause still restricts them to only touching contacts that currently belong to their own campus)
- [x] Quick Add now defaults to the logged-in member's own campus (reads the existing Supabase session) instead of only trusting URL params / this device's `localStorage`, while leaving Quick Add itself login-optional
- [x] **Conclude season now actually locks data**, not just attendance display: `season_concluded()` RLS function; `contacts` INSERT/UPDATE blocked on a concluded season for everyone except `dev`/`campus_admin`. Applies across all three entry points — `index.html` (+New, Edit, the inline reminder dropdown all hide/disable for non-admins), `quick-add.html` (checks session role), and `signup.html` (guests always blocked, no override)
- [x] Reopen season confirmed working — flips a season back to editable, no data loss
- [x] Fixed a real regression: `concludeConfirmDialog` was referenced six times but never declared, silently breaking Conclude/Reopen/Delete-all-contacts/Delete-all-events. Only surfaced once someone actually clicked one, since the script otherwise loaded and parsed fine.
- [x] Fixed dialog CSS: `overflow-y: auto` added, since a tall Settings dialog (once Data/Danger Zone sections were added) could overflow past the visible card with no scrollbar, hiding buttons in a way that looked like a "does nothing" bug rather than a rendering issue

### Phase 2 — Export & import
- [x] `.xlsx` export via SheetJS, generated client-side — "this season only" or "all seasons at this campus," `dev`/`campus_admin` only
- [x] `.xlsx`/`.csv` import with a manual column-mapping step (auto-guesses matches against the app's own export headers), dedupes against the target season by name+phone, chunked insert with per-row fallback so one bad row doesn't block the rest
- [x] Import mapping made robust against DB-style headers too (normalizes underscores/hyphens, adds raw-column-name aliases) after a real incident where a raw-header test CSV silently dropped several fields on import
- [x] Export/Import moved into Settings under a new "Data" section, restyled (scope picker as clickable cards, mapping table cleaned up)
- [x] 2,000-row synthetic test dataset generated and loaded into a dedicated `testload` season for capacity/UX testing

### Small features added along the way (not originally scoped, came up naturally)
- [x] **Pre-delete snapshot** — "Delete all contacts" now backs up the season's contacts to a private `backups` Storage bucket (`.xlsx`, admin-only read/write) *before* deleting, and aborts the delete entirely if the backup upload fails. Deliberately scoped to contacts only, not "Delete all events."
- [x] Search bar on the attendance matrix (`attendance.html`) — filters by name, on top of the existing min-events/by-event filters. Matters a lot more now that a single season can hold thousands of contacts.

## Outstanding — not yet done
- [ ] A full deliberate regression pass across all four access tiers (guest / member / campus_admin / dev), specifically re-verifying after this round of RLS and auth changes
- [ ] `events` table's own RLS was never explicitly re-audited this round — "Delete all events" reuses the same confirm flow as contacts, but its underlying delete policy hasn't been checked against the current campus-scoped model the way `contacts`/`campuses`/`seasons` were
- [ ] Automated tests (none exist)
- [ ] Refactor to reduce per-page code duplication (candidate: introduce a lightweight build step)
- [ ] Aggregate stats / reporting dashboard
- [ ] Multi-date reminders (scoped in detail, explicitly declined for now)
- [ ] Email confirmation on guest sign-up (explicitly declined — WhatsApp preferred; would need a real backend)
- [ ] Revisit member onboarding if OCR's membership grows much larger than one campus's shared credentials can reasonably serve
- [x] Google Form → attendance sync — resolved without needing Edge Functions. `apps-script/event-signup-sync.gs`, triggered on Form submit, matches respondents to existing contacts by phone and writes `event_attendance` directly; multiple matches are flagged back into the Sheet for a member to resolve instead of guessed.
- [x] Google Form sign-up notification email — same script now also emails Faus/Ryan/Joan (`NOTIFY_EMAILS`) on every submission via `MailApp`, reporting the gender/nationality/year/major-school/connector the Form now collects directly, plus a tracker cross-check (connector/source already on file) when matched to an existing contact. Ryan's real address still needs to replace the placeholder in `NOTIFY_EMAILS`.
- [x] Auto-create contacts from cold Google Form sign-ups — previously a "No Match" respondent (someone who filled out the Form without ever being met/added by a member) only got flagged in the Sheet and email, with a member expected to notice and Quick Add them; now the script creates their `contacts` row directly (`source: "online"`) so they actually show up in the tracker. Added a `contacts.gender` column and split the Form's combined "Year and Major" question into separate Year/Major questions to support this; renamed "Course" to "Major / School" across the tracker, Quick Add, and signup.html to match. Added `backfillExistingResponses()` — a manually-run one-off that catches up Form rows submitted before this logic existed (the trigger only fires on new submissions); skips rows already resolved to `Matched:`/`Added new contact:` but correctly reprocesses a stale pre-auto-create `No Match` status rather than treating it as already handled, and doesn't email by default.
- [x] Fixed critical bug: the event question is checkboxes (multi-select), so picking 2+ events produced one comma-joined answer, but the script only ever matched the first event in that string (`.startsWith()` against a single label) — attendance and the notification email silently dropped every event after the first. Now matches every configured label present as a substring (`matchedEventLabels`/`matchedEventIds`), so all selected events get marked and shown. Added `backfillMissingEvents()` to fix rows that were already processed under the old single-event bug — it only adds missing events to a contact it finds by phone (never creates one), avoiding the duplicate-contact risk of blanket-clearing `Match Status` and rerunning `backfillExistingResponses()`.
- [x] Fixed critical bug: `EVENT_ID_BY_LABEL` had the wrong ids for all three events — assumed "same order as creation" instead of the real name-to-id mapping, so every sign-up marked attendance for the wrong event entirely (e.g. picking BBQ Night + Speed Friending actually marked Color Wars + BBQ Night). Verified and corrected against the real `events` table. Any `event_attendance` rows already written under the wrong mapping (a handful of early test sign-ups) need manual correction in `attendance.html` — there's no reliable way to auto-detect which old rows were affected.
- [x] Alt-contact fallback matching — the Form's "no WhatsApp" question now requires `ContactMethod: Username` format; when the WhatsApp match finds nothing, the script parses the handle out and checks it as a substring against `contacts.phone` and `contacts.instagram`. Lets a returning Instagram/WeChat-only sign-up get recognized instead of creating a duplicate contact every time. `backfillMissingEvents()` uses the same fallback.
- [x] Added a dedicated `contacts.instagram` field (Add/Edit dialog, detail view, CSV export/import) instead of cramming an Instagram handle into the "Phone / WeChat ID" field — an `Instagram:` alt-contact answer from the Form now lands there specifically; other methods (WeChat, email) still fall back to `contacts.phone`, same as before.
- [x] Added Gender + Instagram + Year to Quick Add too, for parity with the full Add dialog — deliberately not full parity (Age, Birthday, Faith background, Suggested connection, Follow-up owner, and Reminder date/note stay full-dialog-only, since Quick Add is meant to stay fast for "someone you just met").
- [x] Renamed the "Online Sign-ups" tab in `index.html` to "Event Signups" (still filters on `contacts.source === "online"` under the hood).
- [x] Event Signups tab now shows which event(s) each contact has any engagement with as small badges under their row, colored by their furthest stage reached (yellow interested / green registered — same two-stage model and colors as `attendance.html`), plus a chip row above the list to filter down to one event at a time. Deliberately kept on the tracker side rather than added to `attendance.html` — that page (redesigned separately, see below) is the event-operations tool; the tracker is the person-lookup tool, and duplicating detail columns across both was making things feel cluttered/redundant rather than adding clarity.
- [x] Mateo's `attendance.html` redesign (event chips replacing the filter panel, an interest+attendance split-cell matrix, single-event drill-down with stat cards) merged in — an initial attempt to add Contact/Point-person columns and a "Show details" toggle to that page was dropped in favor of the tracker-side event badges above, to avoid the two pages duplicating the same information in different shapes.
- [x] Sign-up email's connector is now shown as two always-separate lines instead of one merged/backfilled field — "Who they said connected them (form)" vs. "Point person on file (tracker)" — so the team can actually confirm the two agree instead of one silently standing in for the other. See "Event Sign-up Sync" in README.md.
- [x] Fixed critical bug: `createContact()` in `event-signup-sync.gs` could pass `phone: null` (Instagram-only sign-up, or neither WhatsApp nor alt-contact given), but `contacts.phone` is `not null` in the real database — the README's schema doc was wrong about this being nullable — so the insert failed outright instead of creating the contact. Now falls back to an empty string. See "Event Sign-up Sync" in README.md.
- [x] Fixed real bug: saving a contact's per-event interest checkboxes wrote to `event_interest` correctly, but the tracker's in-memory `eventInterestMap` (which the Event Signups badges read from) was never refreshed afterward — so a save looked like it silently did nothing until a full page reload. Now re-fetches after every save.
- [x] **Renamed the "attended" concept to "registered"** to match what it's actually always meant: submitting the Form (or being manually checked off in `attendance.html`) means someone signed up, not that they were confirmed present at the event — that distinct "confirmed showed up" stage doesn't exist yet and is parked for later. Renamed `markAttended()` to `markRegistered()` in `event-signup-sync.gs`, and `event_attendance.attended` to `event_attendance.registered` in the schema (a straight column rename, no data loss). `index.html` badges and `attendance.html`'s split-cell matrix / single-event drill-down are both two-stage now: interested (yellow) -> registered (green). See "Event Sign-up Sync" in README.md for the migration SQL.
- [ ] Email-based reminders — still parked pending real backend infrastructure (Supabase Edge Functions), by design (see Roadmap v2 Phase 3)
- [ ] In-app self-service password change (Settings \u2192 change your own password). Not built yet; in the meantime, a password reset for any campus's account is done directly via SQL (see Credentials section in README.md) since these are synthetic shared-credential emails and Supabase's built-in email-based recovery/magic-link flows don't work against them. A dev-triggered override of *another* account's password would need real backend infrastructure (a service-role-key-holding Edge Function) to do safely from within the app \u2014 explicitly not worth building until/unless the app gets a real backend for other reasons too.
