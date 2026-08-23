# OCR Contact Tracker

Internal outreach contact-tracking app for OCR (Operation Campus/City Reach), spanning multiple university campuses in Hong Kong. Tracks people reached out to during outreach, follow-up reminders, and supports multiple campuses each running multiple seasons over time.

## Overview

A fully static site — no build step, no server, no framework — talking directly to a Supabase backend (Postgres database, Auth, and file Storage) from the browser. Deployed on Vercel's free tier. Every page is a single self-contained `.html` file with inline CSS and vanilla JavaScript, aside from two shared script files.

Built incrementally by a non-professional developer with AI assistance, optimized throughout for zero cost and minimal operational overhead — worth keeping in mind when evaluating architectural choices below; several deliberately favor simplicity over what a funded engineering team might choose.

## Architecture

```
Campuses (campuses.html) — public, browsable without login
  └─ Seasons (seasons.html) — per campus, newest = "Current", public
       └─ Tracker (index.html) — per season, gated behind login, campus-scoped
            ├─ Quick Add (quick-add.html) — fast-path add tool, login-optional
            ├─ Guest Sign-up (signup.html) — public, no login, insert-only
            ├─ Attendance (attendance.html) — per-event matrix + read-only summary once concluded
            └─ Calendar (calendar.html) — reminder agenda + month grid
```

A **campus** (e.g. "PolyU HK") is a top-level org unit. Each campus has any number of **seasons** (e.g. "We Are Here 2026/27") — one season is always treated as "current," determined automatically by whichever was created most recently. Every **contact** belongs to exactly one season via `contacts.season_id`; a contact's campus is derived from that relationship, not stored redundantly (see `contacts_with_campus` below).

### Why one shared database instead of separate databases per campus/season

Considered and explicitly rejected. Supabase's free tier caps at 2 active projects, and projects auto-pause after a week of inactivity — a poor fit for a tool used in bursts between events. More importantly, a single database with tenant-scoping columns (`campus_id` / `season_id`) is the standard way large multi-tenant systems actually scale — physically separate infrastructure per tenant is what you reach for under compliance requirements, not for growth. If a campus ever genuinely needs to be split out, a `select ... where campus_id = X`, export, import into a fresh project is a normal, well-supported migration path.

### Why campus isn't a column on `contacts`

Considered (a `campus_id` column directly on `contacts`) and rejected in favor of a SQL view. A denormalized column would be a second, separately-stored copy of information already implied by `season_id → seasons.campus_id`, and given how many code paths now write to `season_id` (add, edit, Quick Add, Transfer, guest signup), keeping a second copy in sync reliably was judged too risky — and this exact failure mode (a forgotten write path) had already caused a real bug once. See `contacts_with_campus` under Database Schema.

## Tech Stack

- **Frontend:** Plain HTML/CSS/JS. No React, no bundler, no npm install step.
- **Backend:** [Supabase](https://supabase.com) — Postgres database with Row Level Security, Auth (email/password, with a custom `app_metadata` role/campus_id combination distinguishing `dev` / `campus_admin` / plain member), and Storage (file uploads, plus private automatic backups).
- **Hosting:** [Vercel](https://vercel.com), free tier, auto-deploys on push to the connected GitHub repo.
- **Calendar UI:** [flatpickr](https://flatpickr.js.org) (CDN, no install) — replaced native `<input type="date">` due to iOS rendering bugs, lack of typed input, and a real conflict with native `<dialog>` modal rendering (see Known Limitations).
- **Spreadsheet export/import:** [SheetJS](https://sheetjs.com) (`xlsx`, CDN, no install) — generates `.xlsx` client-side for Export and pre-delete backups, and parses uploaded `.xlsx`/`.csv` for Import. No backend involvement in either direction.
- **Fonts:** Google Fonts (Anton, Poppins) via CDN `<link>`.

## File Structure

```
/
├── index.html          Main contact tracker dashboard (per-season, login-gated)
├── campuses.html        Top-level campus hub (public)
├── seasons.html          Per-campus season history (public)
├── signup.html            Public guest sign-up form (no login, insert-only)
├── quick-add.html          Fast-path add tool for members
├── attendance.html          Per-season event attendance matrix + summary view
├── calendar.html             Per-season reminder calendar (agenda + month grid)
├── theme.js                 Shared dark/light mode logic, loaded by every page
├── loading.js                Shared page-loader animation logic, loaded by every page
└── assets/
    └── logo-mark.png           Legacy fallback logo asset — largely superseded by the
                                  text-wordmark fallback pattern now used across pages
```

Each `.html` file is fully self-contained (styles + script inline) except for the two shared JS files. There is deliberately no shared component library or templating — updating something that appears on multiple pages currently means editing each file individually. This tradeoff for staying build-step-free has a real, demonstrated cost:

- It directly caused a bug where duplicate/leftover markup from an earlier edit collided with newer markup by sharing an ID, and separately caused a full CSS variable block to be accidentally deleted during a large rewrite. **After any significant edit touching shared patterns, check for duplicate IDs** (`grep -oE 'id="[a-zA-Z0-9_-]+"' file.html | sort | uniq -c | sort -rn`) before shipping — this is now standard practice, not optional.
- Separately, a variable (`concludeConfirmDialog`) was referenced in six places but its declaration line had gone missing — the file still loaded and parsed with zero errors, since JS doesn't fail until the code that references a missing variable actually *runs*. It silently broke Conclude/Reopen/Delete-all-contacts/Delete-all-events for an unknown period until someone happened to click one. **A syntax check (`node --check`) or a duplicate-ID grep is not enough on its own** — after any edit that touches button wiring or dialog handoffs, actually click the affected buttons (or load the page in a headless DOM and simulate the click) before considering the change safe to ship.

A team picking this up long-term may want to introduce a lightweight build process to de-duplicate the repeated CSS/JS blocks across pages.

## Access Model

Four tiers, enforced at the database level via RLS — not just hidden UI. This replaced an earlier single shared-admin-account model; see Roadmap v2 in ROADMAP.md for how that migration happened.

- **Public** — no login. Can only *insert* new contacts (via the guest sign-up form). Can view campus/season names and branding (needed for the public sign-up flow to work at all, and deliberately left public even post-login-gating — see note below).
- **Member** — logged in with a campus-specific shared credential (e.g. `polyu-member@...`, `cityu-member@...`). Can view and edit contacts, but only within their own campus — enforced by matching `app_metadata.campus_id` against the season's campus in RLS, not just hidden in the UI. The tracker (`index.html`) is fully gated behind login; landing on a *different* campus's season (e.g. via a stale link) shows a clear Access Denied screen rather than a misleadingly empty dashboard.
- **Campus admin** — logged in with `app_metadata.role = "campus_admin"` and a `campus_id`. Everything a member can do within their own campus, plus: delete contacts, create/edit/delete seasons, override page backgrounds, conclude/reopen seasons, Transfer a contact to another campus, and export/import that campus's data.
- **Dev** — logged in with `app_metadata.role = "dev"`, no `campus_id` (not scoped to one campus). Everything a campus admin can do, across every campus, plus: create/delete campuses, edit the site-wide background, and issue new campus-level credentials.

Each campus's member and campus_admin accounts are **shared credentials, admin-created**, not self-service sign-up — a deliberate choice. Open self-registration would let a stranger register their own account in seconds with the same access as a real member, defeating the purpose of gating the tracker at all.

### Why campus/season names stay publicly viewable even after this change

`campuses.html`/`seasons.html` intentionally stayed public-read (no login required) even after campus-scoping was added, because `signup.html` (guest sign-up, zero internal links) needs to read that data to work at all. Restricting *viewing* to logged-in same-campus users only would be trivially bypassed by logging out or opening an incognito tab — real security value comes from restricting *writes*, which is where the RLS scoping actually lives.

### Concluding a season

Concluding a season (Settings → Season status) does more than switch attendance to a read-only summary — it also locks `contacts` (no add/edit/delete, including the inline reminder-date dropdown) for everyone except `dev`/`campus_admin`, across all three entry points: the tracker, Quick Add, and guest sign-up. This is enforced by a `season_concluded()` SQL function baked into the `contacts` INSERT/UPDATE policies, not just hidden buttons. Reopening a season reverses it completely — no data is lost either way.

## Database Schema

Run in the Supabase SQL Editor, in order, if standing this project up from scratch:

```sql
-- Core contacts table
create table contacts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  nationality text,
  gender text,                  -- added later; run `alter table contacts add column gender text;` if missing
  course text,                  -- "Major / School" in the UI
  connector text,              -- "point person" in the UI
  age int,
  year text,
  birthday date,
  phone text not null,          -- empty string allowed, but never null — catches scripts/imports that forget to set it
  instagram text,               -- added later; run `alter table contacts add column instagram text;` if missing
  faith_background text,
  suggested_connection text,
  interest_event boolean default false,
  interest_lg boolean default false,
  interest_church boolean default false,
  progress text,               -- freeform notes (originally named "other")
  reminder_date date,
  reminder_note text,
  source text default 'member', -- 'member' or 'online'
  other_campus_note text,      -- free-text note when the contact's real school
                                -- isn't one of the tracked campuses; does not affect routing
  season_id uuid references seasons(id),
  created_at timestamptz default now()
);

-- Campuses
create table campuses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  photo_url text,
  logo_url text,
  background_override_url text,  -- optional override, distinct from photo_url
  created_at timestamptz default now()
);

-- Seasons
create table seasons (
  id uuid primary key default gen_random_uuid(),
  campus_id uuid references campuses(id) on delete cascade,
  name text not null,
  photo_url text,
  logo_url text,
  background_override_url text,
  created_at timestamptz default now()
);

-- Site-wide settings (currently just the Campuses page's own background)
create table site_settings (
  id text primary key default 'default',
  background_url text,
  updated_at timestamptz default now()
);

-- Computed view: which campus does each contact belong to, live, never stored redundantly
create view contacts_with_campus as
select
  c.*,
  s.name as season_name,
  s.campus_id,
  camp.name as campus_name
from contacts c
left join seasons s on c.season_id = s.id
left join campuses camp on s.campus_id = camp.id;

-- IMPORTANT: views bypass RLS by default in Postgres, running as the view's
-- creator rather than the querying user. This must be set explicitly:
alter view contacts_with_campus set (security_invoker = true);

-- Reusable admin check, reads a tamper-proof flag from the JWT
create or replace function is_admin()
returns boolean
language sql
stable
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
$$;

-- Row Level Security — enable on all four tables
alter table contacts enable row level security;
alter table campuses enable row level security;
alter table seasons enable row level security;
alter table site_settings enable row level security;

-- CONTACTS: viewing and editing require login; delete is admin-only; insert stays open (guests)
create policy "Signed-in users can view contacts" on contacts for select using (auth.role() = 'authenticated');
create policy "Anyone can add contacts" on contacts for insert with check (true);
create policy "Signed-in users can update contacts" on contacts for update using (auth.role() = 'authenticated');
create policy "Only admins can delete contacts" on contacts for delete using (is_admin());

-- CAMPUSES: view is public (guest signup needs it), everything else admin-only
create policy "Anyone can view campuses" on campuses for select using (true);
create policy "Only admins can create campuses" on campuses for insert with check (is_admin());
create policy "Only admins can update campuses" on campuses for update using (is_admin());
create policy "Only admins can delete campuses" on campuses for delete using (is_admin());

-- SEASONS: same pattern
create policy "Anyone can view seasons" on seasons for select using (true);
create policy "Only admins can create seasons" on seasons for insert with check (is_admin());
create policy "Only admins can update seasons" on seasons for update using (is_admin());
create policy "Only admins can delete seasons" on seasons for delete using (is_admin());

-- SITE_SETTINGS: admin-only write, public read
create policy "Anyone can view site settings" on site_settings for select using (true);
create policy "Only admins can insert site settings" on site_settings for insert with check (is_admin());
create policy "Only admins can update site settings" on site_settings for update using (is_admin());
```

### Campus-scoped access additions (Roadmap v2)

The schema above reflects the original single-shared-admin build. Layered on top of it, without changing the original tables:

```sql
-- Reads campus_id straight off the JWT — same tamper-proof mechanism as is_admin()
create or replace function get_user_campus_id()
returns uuid
language sql
stable
as $$
  select (auth.jwt() -> 'app_metadata' ->> 'campus_id')::uuid;
$$;

create or replace function is_dev()
returns boolean
language sql
stable
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'dev', false);
$$;

create or replace function is_campus_admin()
returns boolean
language sql
stable
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'campus_admin', false);
$$;

-- is_admin() now means "dev or campus_admin" — redefined, not a new function
create or replace function is_admin()
returns boolean
language sql
stable
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') in ('dev', 'campus_admin'), false);
$$;

-- A season's campus, looked up by id — used to scope contacts by campus
-- without a denormalized column (same reasoning as contacts_with_campus above)
create or replace function season_campus_id(p_season_id uuid)
returns uuid
language sql
stable
as $$
  select campus_id from seasons where id = p_season_id;
$$;

-- Whether a season has been concluded — used to lock contacts on old seasons
create or replace function season_concluded(p_season_id uuid)
returns boolean
language sql
stable
as $$
  select coalesce((select concluded from seasons where id = p_season_id), false);
$$;

-- campuses/seasons: insert/delete stay dev-only; update opens to a campus_admin
-- editing their own campus/season (still blocked from touching others')
alter policy "Dev or own campus admin can update campuses" on campuses
using (is_dev() or (is_campus_admin() and id = get_user_campus_id()));

-- contacts: select/update scoped to same-campus authenticated users (or dev);
-- delete stays dev/campus_admin-only, also same-campus scoped
create policy "Same-campus users can view contacts" on contacts for select
using (is_dev() or (auth.role() = 'authenticated' and season_campus_id(season_id) = get_user_campus_id()));

create policy "Dev or own campus admin can delete contacts" on contacts for delete
using (is_dev() or (is_campus_admin() and season_campus_id(season_id) = get_user_campus_id()));

-- contacts insert/update: dev and campus_admin can write into ANY campus's
-- season (needed for Transfer) and bypass the concluded-season lock; a plain
-- member stays restricted to their own campus and can't write into a
-- concluded season at all
alter policy "Anyone can add contacts" on contacts
with check (is_dev() or is_campus_admin() or not season_concluded(season_id));

alter policy "Same-campus users can update contacts" on contacts
with check (
  is_dev()
  or is_campus_admin()
  or (
    auth.role() = 'authenticated'
    and season_campus_id(season_id) = get_user_campus_id()
    and not season_concluded(season_id)
  )
);
```

Every campus's `member`/`campus_admin` account gets tagged via the same `raw_app_meta_data` merge pattern used for the original admin account (see Credentials below), just with `campus_id` added:

```sql
update auth.users
set raw_app_meta_data = raw_app_meta_data || '{"role": "campus_admin", "campus_id": "<campus uuid>"}'::jsonb
where email = '<campus>-admin@ocr-tracker.app';
```

A member account gets `campus_id` only, no `role` key at all (absence of `role` is what makes an account a plain member).

### Storage

Two buckets:

- **`branding`** — public read, admin-only write. Campus/season logos and background photos.
- **`backups`** — private, `dev`/`campus_admin`-only read *and* write. Holds automatic `.xlsx` snapshots taken right before "Delete all contacts" runs (see Known Limitations).

```sql
create policy "Public can view branding images" on storage.objects for select using (bucket_id = 'branding');
create policy "Only admins can upload branding images" on storage.objects for insert with check (bucket_id = 'branding' and is_admin());
create policy "Only admins can replace branding images" on storage.objects for update using (bucket_id = 'branding' and is_admin());

create policy "Admins can upload backups" on storage.objects for insert with check (bucket_id = 'backups' and (is_dev() or is_campus_admin()));
create policy "Admins can view backups" on storage.objects for select using (bucket_id = 'backups' and (is_dev() or is_campus_admin()));
```

Create both buckets via the Supabase dashboard (Storage → New bucket) before running the above — `branding` with Public toggled **on**, `backups` with it **off**.

## Credentials

The Supabase **Project URL** and **publishable (anon) key** are hardcoded directly into every `.html` file's `<script>` block. This is intentional — the publishable key is explicitly designed by Supabase to be public-facing; it carries no elevated privileges, and all real access control is enforced server-side by the RLS policies above. Never put the Supabase **secret key** anywhere in this codebase.

Accounts are created manually via Supabase Auth → Users → Add user (sets the password there), then tagged via a `raw_app_meta_data` SQL merge (don't overwrite the field directly — it already holds provider info Supabase needs). One `member` + one `campus_admin` account per campus, plus a single campus-independent `dev` account:

```sql
-- Dev — no campus_id, works across every campus
update auth.users
set raw_app_meta_data = raw_app_meta_data || '{"role": "dev"}'::jsonb
where email = 'dev@ocr-tracker.app';

-- Campus admin — role + that campus's real UUID (from the campuses table)
update auth.users
set raw_app_meta_data = raw_app_meta_data || '{"role": "campus_admin", "campus_id": "<campus uuid>"}'::jsonb
where email = 'polyu-admin@ocr-tracker.app';

-- Member — campus_id only, no role key at all
update auth.users
set raw_app_meta_data = raw_app_meta_data || '{"campus_id": "<campus uuid>"}'::jsonb
where email = 'polyu-member@ocr-tracker.app';
```

**A mistake worth calling out because it happened more than once while setting these up:** if you copy a SQL snippet with a placeholder like `<campus uuid>` or `PASTE-CAMPUS-UUID` and run it without swapping in the real value, the `update` still succeeds — it just writes the literal placeholder text into `campus_id`. There's no error, so it silently produces an account that looks tagged but isn't. Always re-run `select email, raw_app_meta_data from auth.users;` after tagging to visually confirm the value is a real UUID, not placeholder text.

The original single shared `admin@`/`member@` pair from the pre-campus-scoping build can be repurposed (e.g. as the `dev` account) or left alone — untagged/mismatched accounts just fail RLS checks like any other account, they don't get special treatment.

Anyone logged in needs to **log out and back in** after their `app_metadata` is changed — the JWT is issued at login and doesn't pick up metadata changes until a fresh session is created. This is the single most common "why isn't my role change taking effect" cause.

To change a password (lost, mistyped, or just rotating it), use SQL directly rather than Supabase's built-in password-recovery/magic-link buttons in the dashboard — those actually send a real email, and fail outright against these synthetic `@ocr-tracker.app` addresses since nothing real receives mail there:

```sql
create extension if not exists pgcrypto;

update auth.users
set encrypted_password = crypt('the-new-password', gen_salt('bf'))
where email = 'polyu-member@ocr-tracker.app';
```

This writes a real bcrypt hash directly (the same format Supabase's own signup flow produces), so the new password works on the very next login attempt — no confirmation step, no pending state, and `raw_app_meta_data` (role/campus_id tags) is untouched. Only `dev` should be doing this, using SQL Editor access.

For a mistyped or throwaway account with no real data attached, deleting and re-creating it correctly is sometimes simpler than fixing it in place — just remember deleting wipes `raw_app_meta_data` too, so re-run the tagging SQL afterward.

## Event Sign-up Sync (Google Form → Attendance)

Two outreach flows feed the same tracker: someone is met in person and added as a contact in real time (Quick Add or the tracker), or someone signs up cold through the Google Form having never talked to anyone from OCR. `apps-script/event-signup-sync.gs` bridges that Form's response Sheet directly into Supabase, so either way they show up in `attendance.html` for the event they signed up for — no manual re-entry.

Each campus gets its **own** script, pasted into its **own** Form's response Sheet — Apps Script deployments are per-Sheet, not shared, and different campuses' Forms don't necessarily ask the same questions in the same words (or even ask the same questions at all). `apps-script/event-signup-sync.gs` is HKUST's; `apps-script/event-signup-sync-hku.gs` is HKU's LIFE Group Form, which has a genuinely different shape (split First/Last Name, no Nationality question, no "Who connected you?" question, a "Type of Study" question and two extra Yes/No/Maybe questions HKUST's Form doesn't have) — everything below describes HKUST's script specifically; see the HKU file's own header comment for how it differs. Both point at the same Supabase project, just different `SEASON_ID`s.

This intentionally isn't a Supabase Edge Function (see the now-resolved Roadmap item on this). Google Apps Script, bound to the Form's Sheet and triggered `onFormSubmit`, is a free, zero-maintenance equivalent: it runs on Google's servers, not in a browser, so it's a safe place to hold a real secret — unlike every other credential in this project.

**Registered vs. attended (important distinction):** submitting the Form marks someone **registered**, not attended — those are different columns on the same `event_attendance` row (`registered` and `attended`, both boolean). Registered means "signed up in advance"; attended means "actually showed up," confirmed separately by whoever's checking people in at the event, via `attendance.html`. This script never sets `attended` itself, and never overwrites an existing `attended: true` when updating a row (partial `PATCH` bodies in PostgREST only touch the fields present in them). Alongside the registration write, it also inserts an `event_interest` row (interest is even earlier than registered — someone might express interest without ever formally signing up) — that's the same table the tracker's own per-event interest checkboxes read from, so a Gform sign-up shows up as interested there too, not just registered.

`event_attendance` needs both `registered` and `attended` columns for this to work. If your table still has the old single `attended` column doing double duty as "registered" (i.e. it was set the moment someone submitted the Form), migrate it in place rather than adding a redundant new column — this renames the existing data to its correct name, then adds a fresh, empty `attended` for real attendance confirmation to start from:
```sql
alter table event_attendance rename column attended to registered;
alter table event_attendance add column attended boolean default false;
```

`contacts.last_form_connector` also needs to exist — run this once if it doesn't yet:
```sql
alter table contacts add column last_form_connector text;
```

If you're upgrading from before `createContact()` stopped writing the Form's answer into `contacts.connector`, existing online-created contacts may have that bug's leftover data sitting in `connector` — the Form's answer where "Outreached by" should be blank, since nobody outreached to them in person. This moves it to the right field, but only for contacts unambiguously affected (online-sourced, and `last_form_connector` was never populated — meaning they predate the fix):
```sql
update contacts
set last_form_connector = connector, connector = null
where source = 'online' and last_form_connector is null and connector is not null;
```
Doesn't touch anyone who's since had a real "Outreached by" set by a member after the fact (those already have distinct connector/last_form_connector values, so they fall outside this `where` clause) — but if someone submitted the Form more than once, only their *first* submission's answer got this treatment; check anyone like that by hand.
This saves whatever a respondent typed for "Who connected you?" onto their tracker record, separate from `contacts.connector` (the tracker's own point-person field, set via Quick Add/Add Contact/Edit) — the two can legitimately disagree (a member's already the point person on file, but the respondent named someone else on the Form), and the website now shows both instead of the form's answer only ever existing in this one-time email/Sheet row. Always the latest submission's answer; a repeat sign-up overwrites rather than stacking.

**How it matches:** primarily by normalized WhatsApp number (digits only, `852` country code stripped) against `contacts.phone`, scoped to a specific `season_id`. When that finds nothing (or no WhatsApp was given at all), it falls back to the Form's "If you don't have WhatsApp, how can we contact you?" answer — that question now requires the format `ContactMethod: Username` (e.g. `Instagram: username123`), so the script parses out just the handle and checks it as a substring against `contacts.phone` and `contacts.instagram` — a member may have typed a WeChat/Instagram handle into Quick Add's "Phone / WeChat ID" field (with or without the method prefix) instead of using the dedicated Instagram field. Handles under 3 characters are skipped for this fallback, since a very short string risks matching an unrelated phone number.
- **Exactly one match** — that's them, mark them registered in `event_attendance` (see above).
- **Zero matches** — nobody's ever added this person before, so a new contact is created directly from their Form answers (`source: "online"`, same tag `signup.html` self-submissions get — the "Online" badge in the tracker applies here too), then marked registered. An `Instagram:` alt-contact answer goes into the tracker's dedicated `contacts.instagram` field rather than being crammed into `contacts.phone`; any other method (WeChat, email, or no method at all) falls back to `contacts.phone`, same as Quick Add already does. `contacts.phone` is `not null` in Supabase, so if someone gives neither a WhatsApp number nor a usable alt-contact, `createContact()` stores an empty string there rather than `null` — otherwise the insert fails outright. This is what makes cold Form sign-ups actually show up on the website instead of only existing as a Sheet row someone has to notice and Quick Add by hand.
- **Multiple matches** — too ambiguous to guess or safely create (could produce a duplicate), so nothing is written to Supabase; a status goes back into the response row for a member to resolve by hand instead.

If their event answer doesn't match a configured event, the contact is still matched/created as above, just without marking registration for it (and the response row notes that so it doesn't look silently ignored). The event question is a **checkboxes** field, so someone can sign up for more than one event at once — Google Forms joins multiple selections into one comma-separated answer, and since each option's own text already has commas in it ("BBQ Night: Wed, Aug 26, 7PM @HKUST BBQ Pit - Grill, chat..."), the script can't just split on commas. Instead it checks for each `EVENT_ID_BY_LABEL` key as a substring (`"Label:"`) of the full answer, so it correctly finds and marks registration for every event they picked, not just the first one — keep those keys as just the short event name.

**Notification email:** every submission also emails `NOTIFY_EMAILS` (top of the script) — currently Faus and Joan, plus a placeholder slot for Ryan pending his real address. The Form asks gender, nationality, year, major/school, and "Who connected you?" directly, so the email reports those as typed by the respondent. The connector shows up as **two separate lines, never merged**: "Who connected you? (form response)" is exactly what the respondent typed (or blank — it's the one optional Form question), and "Outreached by (tracker)" is `contacts.connector` on the matched tracker record — a member met this person in person and typed themselves in via Quick Add or the tracker's Add Contact dialog, shown only when there's a tracker record to compare against. These two should usually agree, since they're both answering "who connected them" — the form asking the respondent directly, the tracker recording it from the outreach side — but showing both lets the team actually confirm that instead of assuming it; if they *conflict*, the cross-check section flags that explicitly. This is entirely separate from point person (who's *currently* assigned to follow up, a later and always-manual step this email doesn't report on). The form's answer also gets saved to `contacts.last_form_connector` on the matched/created contact, so it's not just visible in this one email — the tracker's website (all tabs) shows the same "Outreached by" field and a separate "Who connected you?" field, plus "Point person," each flagged against each other when they disagree. A contact met in person and later self-registering for an event via the Form still shows up under the Event Signups tab too — that tab now includes anyone with an actual event registration, not just contacts whose original `source` was the Form. The email also always shows `contacts.source` for a matched contact (added manually by a member vs. self-submitted via `signup.html`/the Form). Multiple matches or an unrecognized event still send an email, just flagging what needs manual attention instead of a clean cross-check. Sent via `MailApp`, so no extra credentials beyond the script's own Google account — well within its free daily quota for this volume.

**Point person is always a manual, explicit assignment — never inferred.** Before this, an unset `followup_owner_type` silently fell back to showing `contacts.connector` as the point person, which looked like a confirmed assignment when nobody had actually looked at it. Now `contacts.followup_owner_type` has 4 real states: unset/`null` ("Not yet assigned" — the only default, for every new contact regardless of how it was created), `"connector"` (a member explicitly confirmed the connector *is* the point person), `"suggested"` (assigned to `contacts.suggested_connection`), `"other"` (assigned to `contacts.followup_owner_other`, a free-typed name). If you're upgrading from before this change, existing contacts need a one-time cleanup — anything that was showing a point person purely by the old default (not a real explicit choice) should go back to unassigned:
```sql
update contacts set followup_owner_type = null where followup_owner_type = 'connector';
```
This is safe to run even after some contacts have gotten a *genuine* explicit "Connector" assignment going forward (post-upgrade) — just run it once, immediately after deploying this change, before anyone has a chance to make a new explicit "Connector" choice that this would incorrectly wipe out.

**Important — also check the column's own default.** If `contacts.followup_owner_type` has a database-level `default 'connector'` left over from before this change existed, Postgres applies it to *every new insert* that doesn't explicitly specify the field — silently undoing this feature for every contact created after you run the cleanup above, not just the ones that existed before it. Quick Add and `event-signup-sync.gs` now explicitly send `followup_owner_type: null` on creation as a safeguard, but the column's own default should still be removed at the source:
```sql
alter table contacts alter column followup_owner_type drop default;
```
`followupOwnerDisplay()` also never shows a `"connector"`-type assignment whose value is actually a non-person phrase (`isUnconnected` — "instagram", "ig", blank, etc.) as if it were a real point person's name, even if that got set some other way.

### Setup

1. If `contacts.gender` or `contacts.instagram` don't exist yet, run `alter table contacts add column gender text;` and `alter table contacts add column instagram text;` once in Supabase's SQL Editor — the auto-create path below needs them. If `event_attendance` doesn't have both `registered` and `attended` yet, see the migration above.
2. Open the Form's linked response Sheet → **Extensions → Apps Script**.
3. Paste in `apps-script/event-signup-sync.gs`.
4. Fill in the `CONFIG` block at the top of the script:
   - `SUPABASE_URL` — same project URL already hardcoded in the site's HTML files.
   - `SEASON_ID` — HKUST's current season's `id` (Supabase Table Editor → `seasons`).
   - `EVENT_ID_BY_LABEL` — each event's `id` (Table Editor → `events`, scoped to that season), keyed by the event's short name (e.g. `"BBQ Night"`). **Copy each `id` directly from the table for the name it's actually sitting next to — never assume creation order matches the Form's option order.** A prior version of this file assumed "same order," which was wrong once a teammate's "Manage Events" rename feature (`attendance.html`) let event names get reassigned to existing rows independent of creation order, silently marking the wrong event attended for every sign-up until caught. Keep this in sync if event names change again.
   - The `Q_*` constants — must match the Form's question titles verbatim; double-check against the live Form since Google Forms sometimes folds a parenthetical or description into the title text.
   - `RESPONSES_SHEET_NAME` — the response Sheet's tab name (defaults to Google Forms' auto-generated `"Form Responses 1"`); only used by the backfill step below.
   - `NOTIFY_EMAILS` — swap in Ryan's real address once it's available; add/remove recipients here as needed.
5. **Project Settings (gear icon) → Script Properties → Add property**: name `SUPABASE_SERVICE_ROLE_KEY`, value from Supabase → Project Settings → API → `service_role` secret key. Never paste this key directly into the script body — Script Properties keeps it out of the visible source, and it must never end up in any `.html` file, unlike the anon key.
6. **Triggers (clock icon) → Add Trigger** → function `onFormSubmit`, event source "From spreadsheet", event type "On form submit" → Save. The first real run prompts an authorization screen (this account hasn't granted the script permission to send mail yet) — approve it once, from the account that should appear as the sender.
7. Test twice: once with a phone number already in the tracker (Sheet's `Match Status` should say `Matched: <name>`), and once with a phone number that isn't (`Match Status` should say `Added new contact: <name>` and that person should now appear in the tracker with the "Online" badge). Confirm `event_attendance.registered` is `true` for both in `attendance.html` (not `attended` — that stays `false` until someone's confirmed present at the actual event), and `NOTIFY_EMAILS` received both notification emails.
8. **One-time catch-up for existing responses**: anyone who filled out the Form before this script (or this matching logic) existed was never processed — the trigger only fires on new submissions. Pick `backfillExistingResponses` from the function dropdown next to Run and click Run once. It's safe to re-run (skips rows already resolved to `Matched:`/`Added new contact:`; a stale pre-auto-create `No Match` status from an older script version gets reprocessed, not skipped) and doesn't email `NOTIFY_EMAILS` by default, since a flood of catch-up notifications for old sign-ups isn't useful — flip the `sendEmail` flag inside that function first if you do want them.
9. **If you ran a backfill before the multi-event fix existed**: rows that picked 2+ events may have only gotten the first one marked attended, and now carry a status that step 8 will skip as already-handled. Run `backfillMissingEvents` once instead — it only adds missing events for a contact it can already find by phone (never creates or matches a new one), so it can't produce a duplicate contact the way clearing `Match Status` and reprocessing everything could for someone who signed up with no WhatsApp number. Check the Execution log afterward for any names it flagged as needing a manual look.

Because this uses the service role key, it bypasses RLS entirely — no new Supabase policies are needed, and none should be added just for this script.

## Local Development

No build tools, no `npm install`. Open any `.html` file directly in a browser, or serve the folder with any static file server (e.g. VS Code's "Live Server" extension) for a closer match to production. Changes to Supabase (schema, policies) are made directly via the Supabase SQL Editor or dashboard — there's no local database or migration tooling.

## Deployment

Push to the connected GitHub repository's main branch; Vercel auto-deploys. No CI, no build step, no environment variables to configure on Vercel's side — everything needed is already in the HTML.

## Known Limitations & Things to Know

- **Per-page code duplication is real, demonstrated technical debt.** Shared logic is copy-pasted across seven HTML files rather than centralized. This has directly caused bugs: a duplicate-ID collision from leftover markup in one edit caused a button to silently do nothing (its click handler bound to a hidden duplicate element, not the visible one); a separate edit accidentally deleted an entire foundational CSS block; and a missing variable declaration (not a duplicate, an *absent* one) broke four Danger Zone / season-status buttons with zero errors until someone actually clicked them. **After significant edits: grep for duplicate IDs, run a syntax check, and actually click the affected buttons** — the first two catch different failure classes than the third, and none of them substitute for the others.
- **`<dialog>` modals are manually managed** in `index.html` (a plain backdrop `<div>` plus `dialog.show()`), not using the browser's native `showModal()`/top-layer behavior. This was a deliberate fix for a genuine conflict: flatpickr's calendar popup was rendering *invisibly* behind native modal dialogs, because native modals use a special browser rendering layer that a library appending to `document.body` isn't part of. If touching dialog code, be aware this isn't standard `<dialog>` usage and don't "simplify" it back to `showModal()` without understanding why. Also worth knowing: the `<dialog>` CSS sets a `max-height` but relies on `overflow-y: auto` to handle content taller than that — without it, overflow content renders *outside* the visible card with no scrollbar, which looks exactly like a "this button doesn't exist" bug rather than a rendering one. Keep that rule in place as more sections get added to any dialog.
- **Views bypass Postgres RLS by default.** Any new view created on this database needs `security_invoker = true` explicitly set, or it will silently expose data regardless of the underlying tables' policies. Supabase's dashboard flags this with an "Unrestricted" badge — take it seriously.
- **RLS blocking a query returns an empty result, not an error.** The app can't distinguish "no rows exist" from "you're not allowed to see any" purely from a query result — this is why the Access Denied page exists on `index.html` (an explicit campus-mismatch check run before the query, not inferred from an empty result afterward). If contacts ever appear mysteriously empty for a real user, check `raw_app_meta_data` and RLS policies before assuming it's a data problem, and remember a stale JWT (user hasn't logged out/in since a role/campus change) produces the exact same symptom.
- **No automated tests.** Everything has been manually verified through the browser as it was built. A full deliberate regression pass across all four access tiers (guest / member / campus_admin / dev) is recommended after any auth-related change, not just a quick glance — see the Outstanding section of ROADMAP.md, this hasn't been done yet for the campus-scoping changes.
- **Import's automatic column matching is exact-normalized, not fuzzy.** It handles underscore/hyphen variations and a fixed list of known aliases (so re-importing the app's own Export, or a raw database-column-named CSV, both auto-map correctly), but a genuinely differently-worded header (e.g. "WeChat handle" instead of "Phone / WeChat") won't guess correctly and needs manual mapping — which the UI supports, it just won't be pre-filled.
- **Reminders are single-date-per-contact.** A multi-reminder system (separate `reminders` table, one-to-many) was scoped and explicitly deferred.
- **iOS-specific fixes worth not accidentally reverting:** the mobile font-size-16px rule preventing Safari's zoom-on-focus, and the move away from native date inputs entirely (they overflow their container unpredictably on iOS and can't be restyled).
