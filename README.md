# OCR Contact Tracker

Internal outreach contact-tracking app for OCR (Operation Campus/City Reach), spanning multiple university campuses in Hong Kong. Tracks people reached out to during outreach, follow-up reminders, and supports multiple campuses each running multiple seasons over time.

## Overview

A fully static site — no build step, no server, no framework — talking directly to a Supabase backend (Postgres database, Auth, and file Storage) from the browser. Deployed on Vercel's free tier. Every page is a single self-contained `.html` file with inline CSS and vanilla JavaScript, aside from two shared script files.

Built incrementally by a non-professional developer with AI assistance, optimized throughout for zero cost and minimal operational overhead — worth keeping in mind when evaluating architectural choices below; several deliberately favor simplicity over what a funded engineering team might choose.

## Architecture

```
Campuses (campuses.html) — public, browsable without login
  └─ Seasons (seasons.html) — per campus, newest = "Current", public
       └─ Tracker (index.html) — per season, gated behind login
            ├─ Quick Add (quick-add.html) — fast-path add tool for members
            └─ Guest Sign-up (signup.html) — public, no login, insert-only
```

A **campus** (e.g. "PolyU HK") is a top-level org unit. Each campus has any number of **seasons** (e.g. "We Are Here 2026/27") — one season is always treated as "current," determined automatically by whichever was created most recently. Every **contact** belongs to exactly one season via `contacts.season_id`; a contact's campus is derived from that relationship, not stored redundantly (see `contacts_with_campus` below).

### Why one shared database instead of separate databases per campus/season

Considered and explicitly rejected. Supabase's free tier caps at 2 active projects, and projects auto-pause after a week of inactivity — a poor fit for a tool used in bursts between events. More importantly, a single database with tenant-scoping columns (`campus_id` / `season_id`) is the standard way large multi-tenant systems actually scale — physically separate infrastructure per tenant is what you reach for under compliance requirements, not for growth. If a campus ever genuinely needs to be split out, a `select ... where campus_id = X`, export, import into a fresh project is a normal, well-supported migration path.

### Why campus isn't a column on `contacts`

Considered (a `campus_id` column directly on `contacts`) and rejected in favor of a SQL view. A denormalized column would be a second, separately-stored copy of information already implied by `season_id → seasons.campus_id`, and given how many code paths now write to `season_id` (add, edit, Quick Add, Transfer, guest signup), keeping a second copy in sync reliably was judged too risky — and this exact failure mode (a forgotten write path) had already caused a real bug once. See `contacts_with_campus` under Database Schema.

## Tech Stack

- **Frontend:** Plain HTML/CSS/JS. No React, no bundler, no npm install step.
- **Backend:** [Supabase](https://supabase.com) — Postgres database with Row Level Security, Auth (email/password, with a custom `app_metadata` role flag for admin distinction), and Storage (file uploads).
- **Hosting:** [Vercel](https://vercel.com), free tier, auto-deploys on push to the connected GitHub repo.
- **Calendar UI:** [flatpickr](https://flatpickr.js.org) (CDN, no install) — replaced native `<input type="date">` due to iOS rendering bugs, lack of typed input, and a real conflict with native `<dialog>` modal rendering (see Known Limitations).
- **Fonts:** Google Fonts (Anton, Poppins) via CDN `<link>`.

## File Structure

```
/
├── index.html          Main contact tracker dashboard (per-season, login-gated)
├── campuses.html        Top-level campus hub (public)
├── seasons.html          Per-campus season history (public)
├── signup.html            Public guest sign-up form (no login, insert-only)
├── quick-add.html          Fast-path add tool for members
├── theme.js                 Shared dark/light mode logic, loaded by every page
├── loading.js                Shared page-loader animation logic, loaded by every page
└── assets/
    └── logo-mark.png           Legacy fallback logo asset — largely superseded by the
                                  text-wordmark fallback pattern now used across pages
```

Each `.html` file is fully self-contained (styles + script inline) except for the two shared JS files. There is deliberately no shared component library or templating — updating something that appears on multiple pages currently means editing each file individually. This tradeoff for staying build-step-free has a real, demonstrated cost: it directly caused a bug where duplicate/leftover markup from an earlier edit collided with newer markup by sharing an ID, and separately caused a full CSS variable block to be accidentally deleted during a large rewrite. **After any significant edit touching shared patterns, check for duplicate IDs** (`grep -oE 'id="[a-zA-Z0-9_-]+"' file.html | sort | uniq -c | sort -rn`) before shipping — this is now standard practice, not optional. A team picking this up long-term may want to introduce a lightweight build process to de-duplicate the repeated CSS/JS blocks across pages.

## Access Model

Three tiers, enforced at the database level via RLS — not just hidden UI:

- **Public** — no login. Can only *insert* new contacts (via the guest sign-up form). Can view campus/season names and branding (needed for the public sign-up flow to work at all).
- **Member** — logged in with the shared member credential. Can view and edit contacts. The tracker (`index.html`) is fully gated behind a real login screen at this tier — not reachable without signing in.
- **Admin** — logged in with an account carrying `app_metadata.role = "admin"`. Everything a member can do, plus: delete contacts, create/edit/delete campuses and seasons, override page backgrounds, and use the dedicated cross-campus Transfer function.

Both the member and admin accounts are **shared credentials, admin-created**, not self-service sign-up — a deliberate choice. Open self-registration would let a stranger register their own account in seconds with the same access as a real member, defeating the purpose of gating the tracker at all.

## Database Schema

Run in the Supabase SQL Editor, in order, if standing this project up from scratch:

```sql
-- Core contacts table
create table contacts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  nationality text,
  course text,
  connector text,              -- "point person" in the UI
  age int,
  year text,
  birthday date,
  phone text,
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

### Storage

One bucket, `branding`, public read, admin-only write:

```sql
create policy "Public can view branding images" on storage.objects for select using (bucket_id = 'branding');
create policy "Only admins can upload branding images" on storage.objects for insert with check (bucket_id = 'branding' and is_admin());
create policy "Only admins can replace branding images" on storage.objects for update using (bucket_id = 'branding' and is_admin());
```

Create the bucket itself via the Supabase dashboard (Storage → New bucket → name `branding` → toggle Public on) before running the above.

## Credentials

The Supabase **Project URL** and **publishable (anon) key** are hardcoded directly into every `.html` file's `<script>` block. This is intentional — the publishable key is explicitly designed by Supabase to be public-facing; it carries no elevated privileges, and all real access control is enforced server-side by the RLS policies above. Never put the Supabase **secret key** anywhere in this codebase.

Two shared accounts exist, both created manually via Supabase Auth → Users, not through any public sign-up flow:

- **Admin** (`admin@ocr-tracker.app`) — flagged via `raw_app_meta_data`. To set this flag on an account, merge it in via SQL (don't overwrite the field directly — it already holds provider info Supabase needs):
  ```sql
  update auth.users
  set raw_app_meta_data = raw_app_meta_data || '{"role": "admin"}'::jsonb
  where email = 'admin@ocr-tracker.app';
  ```
- **Member** (`member@ocr-tracker.app`) — no special flag; default tier is member.

To rotate a password or add a genuinely separate identity, do so directly in the Supabase dashboard.

## Local Development

No build tools, no `npm install`. Open any `.html` file directly in a browser, or serve the folder with any static file server (e.g. VS Code's "Live Server" extension) for a closer match to production. Changes to Supabase (schema, policies) are made directly via the Supabase SQL Editor or dashboard — there's no local database or migration tooling.

## Deployment

Push to the connected GitHub repository's main branch; Vercel auto-deploys. No CI, no build step, no environment variables to configure on Vercel's side — everything needed is already in the HTML.

## Known Limitations & Things to Know

- **Per-page code duplication is real, demonstrated technical debt.** Shared logic is copy-pasted across five HTML files rather than centralized. This has directly caused bugs: a duplicate-ID collision from leftover markup in one edit caused a button to silently do nothing (its click handler bound to a hidden duplicate element, not the visible one), and a separate edit accidentally deleted an entire foundational CSS block. **Always grep for duplicate IDs after significant edits** before considering a change safe to ship.
- **`<dialog>` modals are manually managed** in `index.html` (a plain backdrop `<div>` plus `dialog.show()`), not using the browser's native `showModal()`/top-layer behavior. This was a deliberate fix for a genuine conflict: flatpickr's calendar popup was rendering *invisibly* behind native modal dialogs, because native modals use a special browser rendering layer that a library appending to `document.body` isn't part of. If touching dialog code, be aware this isn't standard `<dialog>` usage and don't "simplify" it back to `showModal()` without understanding why.
- **Views bypass Postgres RLS by default.** Any new view created on this database needs `security_invoker = true` explicitly set, or it will silently expose data regardless of the underlying tables' policies. Supabase's dashboard flags this with an "Unrestricted" badge — take it seriously.
- **No automated tests.** Everything has been manually verified through the browser as it was built. A full deliberate pass across all four access tiers (guest / member / admin / signed-out) is recommended after any auth-related change, not just a quick glance.
- **No CSV export, no aggregate reporting** — noted as a future item, not built.
- **Reminders are single-date-per-contact.** A multi-reminder system (separate `reminders` table, one-to-many) was scoped and explicitly deferred.
- **iOS-specific fixes worth not accidentally reverting:** the mobile font-size-16px rule preventing Safari's zoom-on-focus, and the move away from native date inputs entirely (they overflow their container unpredictably on iOS and can't be restyled).
