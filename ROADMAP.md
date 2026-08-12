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

## Outstanding — not yet done
- [ ] A full deliberate regression pass across all four access tiers (guest / member / admin / signed-out)
- [ ] Automated tests (none exist)
- [ ] Refactor to reduce per-page code duplication (candidate: introduce a lightweight build step)
- [ ] CSV export / aggregate stats
- [ ] Multi-date reminders (scoped in detail, explicitly declined for now)
- [ ] Email confirmation on guest sign-up (explicitly declined — WhatsApp preferred; would need a real backend)
- [ ] Revisit member onboarding if OCR's membership grows much larger than one shared credential can reasonably serve
