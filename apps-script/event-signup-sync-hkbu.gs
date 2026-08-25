/**
 * Bridges the "LIFE Group @HKBU Welcoming Activities 2026" Google Form to
 * the OCR Contact Tracker's Supabase database — the HKBU counterpart to
 * event-signup-sync.gs (HKUST's Form/Sheet), event-signup-sync-hku.gs
 * (HKU's), and event-signup-sync-cuhk.gs (CUHK's). Same underlying idea and
 * same Supabase project, but HKBU's Form has its own shape (one Name field,
 * "Which country are you from?" instead of "Nationality", optional Gender,
 * no "How did you get connected?" question, and contact info split across
 * TWO questions — a checkbox list of which methods someone has, plus a
 * separate freeform field for the actual handle/number), so this is its
 * own script rather than one shared file trying to configure around four
 * different shapes.
 *
 * Setup: paste this into Extensions > Apps Script on HKBU's OWN Form's
 * linked response Sheet (a separate Sheet from HKUST's/HKU's/CUHK's — Apps
 * Script is per-Sheet, this doesn't share a deployment with the other
 * three scripts). Fill in the CONFIG block below, store the service role
 * key in Script Properties (never here in the code — same key as the
 * other scripts can be reused, it's the same Supabase project), then add
 * an installable "On form submit" trigger pointing at onFormSubmit.
 *
 * Matching: primarily by normalized phone number against contacts.phone,
 * scoped to SEASON_ID. When there's no phone match (or no phone given at
 * all — Contact Number is actually a required Form question here, but
 * this still degrades gracefully same as the other scripts), falls back
 * to the "Information of other contact methods" answer — like HKU's/
 * CUHK's Form, HKBU's doesn't require a strict "ContactMethod: Username"
 * format, so parseAltContact() treats anything with no colon as a bare
 * handle with an empty method (falls back to contacts.phone rather than
 * the dedicated contacts.instagram field in that case). The separate
 * "Other preferred contact methods" checkbox question (email/Instagram/
 * WeChat/Other) is just which channels someone has, not the actual handle
 * — it isn't used for matching, only saved as a note (see buildExtraNotes).
 *   - Exactly one match -> that's them, just mark them registered.
 *   - Zero matches -> nobody's added this person before, so a new contact
 *     is created directly from their Form answers (source: "online"), then
 *     marked registered. No manual Quick Add step needed.
 *   - Multiple matches -> too ambiguous to guess or create a duplicate; a
 *     status is written back to the response row for a member to resolve
 *     by hand instead.
 * If their event answer doesn't match a configured event, the contact is
 * still matched/created as above, just without marking registration for it.
 * The event question is checkboxes (multi-select), so a person can pick
 * more than one — every recognized event gets marked registered, not just
 * the first one in their answer.
 *
 * Event matching is deliberately CASE-INSENSITIVE here, unlike the other
 * three scripts — HKBU's option text mixes "LIFE GROUP TASTER" (all caps)
 * with "Island Day"/"We Are Here to Discover" (title case) and is full of
 * emoji clutter, so matching on an exact-case substring would be fragile.
 * See matchedEventLabels() below.
 *
 * Registered vs. attended: submitting the Form only means someone signed up
 * (event_attendance.registered). It is NOT the same as showing up — that's
 * event_attendance.attended, confirmed separately by whoever's checking
 * people in at the actual event via attendance.html. This script never
 * sets `attended` itself. It also inserts an event_interest row
 * (markInterested) for the same event, since signing up clearly implies
 * interest — that's what the tracker's own per-event interest checkboxes
 * read from.
 *
 * Extra Form-only info (which contact methods someone has, and any
 * questions/comments) has no dedicated contacts.* column, so it's folded
 * into contacts.progress as a short note instead of being silently
 * dropped — only on CREATE, never appended to an existing (matched)
 * contact's progress notes, so it can't clobber something a member
 * already wrote there by hand.
 *
 * Notification email: every submission also emails NOTIFY_EMAILS below.
 * Same two-separate-lines treatment as HKUST's script for the connector —
 * except HKBU's Form doesn't ask "How did you get connected?" at all, so
 * that line always reads "(not given)" here; "Outreached by (tracker)"
 * still shows contacts.connector on a matched contact, since that's set
 * independently via Quick Add/Add Contact/Edit, not from this Form. Sent
 * via MailApp, so no extra credentials beyond a valid Google account
 * running the script (free quota: 100 emails/day on a plain Gmail
 * account, 1,500/day on Workspace — far above real signup volume).
 *
 * Schema note: this Form reuses columns the other scripts' setup already
 * required (contacts.gender, contacts.instagram) — no new migration
 * needed if any of those is already running.
 *
 * Backfill: the trigger only ever fires on new submissions, so responses
 * from before this script existed were never processed. Run
 * backfillExistingResponses() once manually (Apps Script editor -> pick it
 * from the function dropdown -> Run) to catch those up; it skips rows
 * already resolved to "Matched:" or "Added new contact:", but reprocesses
 * anything else.
 *
 * If you already ran a backfill before some events existed in
 * EVENT_ID_BY_LABEL, rows that picked events added later may have only
 * gotten some of their choices marked registered, and now carry a
 * "Matched:"/"Added new contact:" status that backfillExistingResponses()
 * will skip. Run backfillMissingEvents() once to fix just that gap — it
 * only marks additional events for a contact it can already find by
 * phone, it never creates/matches a new one, so it's safe even for rows
 * that were auto-created (unlike clearing Match Status and reprocessing
 * everything, which could create a duplicate contact for anyone who
 * signed up with no usable phone).
 */

// === CONFIG — fill these in before using ===

const SUPABASE_URL = "https://xyoniqfmujidoxpgcjlo.supabase.co";

// The tab name of the Form's response Sheet (bottom tab in Google Sheets).
// Only used by backfillExistingResponses() below — the live onFormSubmit
// trigger always gets the right sheet from the event object itself. Google
// Forms defaults new response Sheets to this name — check HKBU's actual
// Sheet tab and update if it's been renamed.
const RESPONSES_SHEET_NAME = "Form Responses 1";

// TODO: HKBU's season id (Supabase Table Editor -> seasons -> copy the
// row's id, after creating an HKBU campus + season via campuses.html /
// seasons.html if one doesn't exist yet). Must be updated whenever a new
// season starts.
const SEASON_ID = "7f7adcd9-47cf-4479-a96e-f92042e7d493";

// TODO: maps each event to its Supabase id (Table Editor -> events -> copy
// each row's id for the events belonging to SEASON_ID above — create the 4
// events for this season first via attendance.html's "Manage Events"). The
// Form's event question answer text includes the full option text (emoji,
// dates, and a "Details:" paragraph), not just the short label, so
// matching below is done by "answer includes this label" (case-
// insensitive — see matchedEventLabels()), not exact equality — keep
// these keys as just the short event name.
const EVENT_ID_BY_LABEL = {
  "LIFE Group Taster": "df0536e0-f5c9-4dad-9a2b-e6a24c92f236",
  "Island Day": "61ae3925-6c91-4357-ad0e-12b1602529f4",
  "We Are Here to Discover": "f4639a64-c997-4934-9c9c-1c6b1c28b47e",
  "First LIFE Group of the Semester": "638771b4-486e-4ea2-87d7-18b1aa01be96",
};

// Exact Form question titles — must match the Form verbatim (getAnswer()
// below falls back to a prefix match, so a minor later edit to add
// instructions/typo-fixes to a question won't silently break this).
const Q_NAME = "Name";
const Q_YEAR = "Year of study";
const Q_GENDER = "Gender";
const Q_COUNTRY = "Which country are you from?";
const Q_MAJOR = "Your Major";
const Q_PHONE = "Contact Number (WhatsApp enabled)";
const Q_ALT_METHODS = "Other preferred contact methods";
const Q_ALT_CONTACT = "Information of other contact methods";
const Q_EVENT = "Which of the following activities are you interested in joining?";
const Q_QUESTIONS = "Do you have any questions or comments?";

// Notified on every Form submission.
const NOTIFY_EMAILS = [
  "faviolafaustina@gmail.com",
];

// === End of config ===

// The event question is a checkboxes field, so picking more than one event
// gives an answer like "✝️ LIFE GROUP TASTER 💬 🎸 27 Aug (Thu)\nDetails:
// ..., 🏝️ Island Day (Sai Kung) 🌊 ☀️ 29 Aug (Sat)\nDetails: ..." — Google
// Forms joins multiple selections with ", ", and each option's own text
// already has commas (and newlines) in it, so a naive split on "," would
// shred it. Instead, check for each configured label as a
// CASE-INSENSITIVE substring — this finds every event they picked
// regardless of order, how many, or whether Google Forms' own option text
// capitalization ("LIFE GROUP TASTER" vs "Island Day") is consistent.
function matchedEventLabels(answerText) {
  const lower = answerText.toLowerCase();
  return Object.keys(EVENT_ID_BY_LABEL).filter(l => lower.includes(l.toLowerCase()));
}

function matchedEventIds(answerText) {
  return matchedEventLabels(answerText).map(l => EVENT_ID_BY_LABEL[l]);
}

// Display-only: the short label(s) actually recognized, joined for
// showing in the email/subject. Falls back to the raw answer if nothing
// configured was recognized at all (so it's never silently blank).
function eventLabelsDisplay(answerText) {
  const labels = matchedEventLabels(answerText);
  return labels.length ? labels.join(", ") : answerText;
}

function onFormSubmit(e) {
  // A trigger set up as "From spreadsheet / On form submit" hands us
  // e.namedValues (column header -> [answer]), not e.response — that
  // shape only exists on a trigger bound directly to the Form itself.
  processResponseRow(e.namedValues || {}, e.range.getSheet(), e.range.getRow(), true);
}

// Shared by onFormSubmit (live trigger) and backfillExistingResponses
// (catching up rows submitted before this script/trigger existed). Takes
// namedValues in the same {questionTitle: [answer]} shape either way, so
// a backfilled row is processed identically to a real-time one.
function processResponseRow(namedValues, sheet, row, sendEmail) {
  // Exact match first (the common case, and the fast path). Falls back to
  // "actual key starts with this Q_ constant" so a later Form edit that
  // appends usage instructions or fixes a typo in a question doesn't
  // silently break matching for that field.
  const getAnswer = title => {
    let v = namedValues[title];
    if (!v) {
      const key = Object.keys(namedValues).find(k => k.startsWith(title));
      v = key ? namedValues[key] : undefined;
    }
    return v && v.length ? String(v[0]) : "";
  };

  const form = {
    name: getAnswer(Q_NAME).trim(),
    year: getAnswer(Q_YEAR).trim(),
    gender: getAnswer(Q_GENDER).trim(),
    country: getAnswer(Q_COUNTRY).trim(),
    major: getAnswer(Q_MAJOR).trim(),
    eventLabel: getAnswer(Q_EVENT).trim(),
    rawPhone: getAnswer(Q_PHONE).trim(),
    altMethods: getAnswer(Q_ALT_METHODS).trim(),
    altContact: getAnswer(Q_ALT_CONTACT).trim(),
    questions: getAnswer(Q_QUESTIONS).trim(),
    connector: "", // this Form doesn't ask "How did you get connected?" at all
  };
  const phone = normalizePhone(form.rawPhone);
  const altContact = parseAltContact(form.altContact);
  const eventIds = matchedEventIds(form.eventLabel);

  try {
    let matches = [];
    if (phone) {
      matches = findContactsByPhone(phone);
    }
    // No phone match (or no phone given at all) — try the alt-contact
    // handle against the tracker's phone field, since that's the only
    // field on that side that could hold it. Only for handles with enough
    // characters to mean something — a one/two-character handle risks
    // matching unrelated phone numbers.
    if (matches.length === 0 && altContact.handle.length >= 3) {
      matches = findContactsByHandle(altContact.handle);
    }

    if (matches.length > 1) {
      const names = matches.map(c => c.name).join(", ");
      writeStatus(sheet, row, `Multiple Matches (${names}) — review manually`);
      if (sendEmail) notifySignup({ form, matchStatus: "multiple", matches, eventIds });
      return;
    }

    let contact = matches[0] || null;
    const matchStatus = contact ? "matched" : "created";
    if (!contact) {
      contact = createContact(form, altContact);
    }

    let statusText = matchStatus === "matched" ? `Matched: ${contact.name}` : `Added new contact: ${contact.name}`;
    if (eventIds.length) {
      eventIds.forEach(id => { markRegistered(contact.id, id); markInterested(contact.id, id); });
      if (eventIds.length > 1) statusText += ` — ${eventIds.length} events`;
    } else {
      statusText += ` — unrecognized event "${form.eventLabel}", not marked registered`;
    }
    writeStatus(sheet, row, statusText);
    if (sendEmail) notifySignup({ form, matchStatus, contact, eventIds });
  } catch (err) {
    writeStatus(sheet, row, `Error: ${err.message || err}`);
  }
}

// One-off catch-up for rows submitted before this script (or the
// auto-create/matching logic) existed, so they don't stay stuck as bare
// Sheet rows nobody's tracker record ever picked up. Run this manually
// once (select it in the dropdown next to Run, click Run) — it's safe to
// re-run since rows already resolved to "Matched:"/"Added new contact:"
// are skipped (anything else gets reprocessed).
//
// Emails are OFF by default here on purpose — you don't want a flood of
// catch-up notifications for people who signed up weeks ago. Pass `true`
// (edit the call at the bottom of this function, or run it from the
// console) if you do want NOTIFY_EMAILS to hear about each one.
function backfillExistingResponses() {
  const sendEmail = false;
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RESPONSES_SHEET_NAME);
  if (!sheet) throw new Error(`No sheet named "${RESPONSES_SHEET_NAME}" — check RESPONSES_SHEET_NAME in the CONFIG block.`);

  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const statusCol = headers.indexOf("Match Status");

  let processed = 0;
  for (let i = 1; i < data.length; i++) {
    const currentStatus = statusCol !== -1 ? String(data[i][statusCol] || "") : "";
    if (/^(Matched:|Added new contact:)/.test(currentStatus)) continue;
    const namedValues = {};
    headers.forEach((h, idx) => { namedValues[h] = [String(data[i][idx] || "")]; });
    processResponseRow(namedValues, sheet, i + 1, sendEmail);
    processed++;
    Utilities.sleep(300); // gentle pacing against Supabase/Mail rate limits
  }
  Logger.log(`Backfill done — processed ${processed} row(s).`);
}

// One-off fix for rows that picked MORE THAN ONE event but only got some
// of them marked (e.g. an event was added to EVENT_ID_BY_LABEL after this
// row was first processed). Deliberately narrower than
// backfillExistingResponses: this NEVER creates or matches a new contact —
// it only looks up an existing contact by phone and marks any additional
// events found. That makes it safe to run even on rows that already got
// auto-created, since it can't produce a duplicate contact the way
// clearing Match Status and reprocessing everything could for anyone who
// signed up with no usable phone (there'd be nothing to match them back to
// their own record, so it'd create a second one instead of fixing
// anything). Rows with no phone are logged for manual follow-up instead of
// guessed.
function backfillMissingEvents() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RESPONSES_SHEET_NAME);
  if (!sheet) throw new Error(`No sheet named "${RESPONSES_SHEET_NAME}" — check RESPONSES_SHEET_NAME in the CONFIG block.`);

  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const nameCol = headers.indexOf(Q_NAME);
  const eventCol = headers.indexOf(Q_EVENT);
  const phoneCol = headers.indexOf(Q_PHONE);
  const altContactCol = headers.indexOf(Q_ALT_CONTACT);
  if (eventCol === -1 || phoneCol === -1) {
    throw new Error("Couldn't find the event or phone column — check Q_EVENT/Q_PHONE match the Sheet's header row.");
  }

  let fixed = 0;
  const needsManualCheck = [];

  for (let i = 1; i < data.length; i++) {
    const eventIds = matchedEventIds(String(data[i][eventCol] || ""));
    if (eventIds.length < 2) continue; // only one (or zero) events selected, nothing missing

    const who = nameCol !== -1 ? String(data[i][nameCol] || "") : `row ${i + 1}`;
    const phone = normalizePhone(String(data[i][phoneCol] || ""));
    const altHandle = altContactCol !== -1 ? parseAltContact(String(data[i][altContactCol] || "")).handle : "";

    let matches = phone ? findContactsByPhone(phone) : [];
    if (matches.length === 0 && altHandle.length >= 3) {
      matches = findContactsByHandle(altHandle);
    }
    if (matches.length === 0) {
      needsManualCheck.push(`${who} (no phone or usable alt-contact to match)`);
      continue;
    }
    if (matches.length !== 1) {
      needsManualCheck.push(`${who} (${matches.length} tracker matches)`);
      continue;
    }

    eventIds.forEach(id => { markRegistered(matches[0].id, id); markInterested(matches[0].id, id); });
    fixed++;
    Utilities.sleep(200); // gentle pacing against Supabase rate limits
  }

  Logger.log(`Fixed missing events for ${fixed} row(s).` +
    (needsManualCheck.length ? ` Needs manual check: ${needsManualCheck.join("; ")}` : ""));
}

// Never throws — a Mail failure shouldn't clobber the Match Status write
// that already happened in onFormSubmit above.
function notifySignup(info) {
  try {
    if (!NOTIFY_EMAILS.length) return;
    const name = info.form.name || "(no name given)";
    const event = eventLabelsDisplay(info.form.eventLabel);
    const subject = `LIFE @ HKBU Sign-up: ${name}` + (event ? ` — ${event}` : "");
    MailApp.sendEmail({
      to: NOTIFY_EMAILS.join(","),
      subject,
      body: buildNotificationBody(info), // plain-text fallback for clients that don't render HTML
      htmlBody: buildNotificationHtml(info),
    });
  } catch (err) {
    Logger.log(`notifySignup failed: ${err.message || err}`);
  }
}

function sourceLabel(source) {
  return source === "online"
    ? "Submitted themselves via the guest sign-up form (signup.html)"
    : "Added manually by an OCR member (in-person conversation)";
}

// Cross-check section content shared by the plain-text and HTML bodies:
// a status ("ok"/"warn") plus one or more lines of detail. This Form
// doesn't ask "How did you get connected?", so there's no form-vs-tracker
// connector comparison here (unlike HKUST's script) — just the entry
// method and any multi-match/unrecognized-event flags.
function crossCheckStatus(info) {
  const f = info.form;
  const lines = [];
  let status = "ok";

  if (info.matchStatus === "matched") {
    const c = info.contact;
    lines.push(`How they entered the tracker: ${sourceLabel(c.source)}`);
  } else if (info.matchStatus === "created") {
    lines.push("Wasn't in the tracker yet — added automatically from their sign-up answers.");
  } else if (info.matchStatus === "multiple") {
    lines.push(
      `Multiple possible matches in the tracker (${info.matches.map(m => m.name).join(", ")}) — ` +
      `a member needs to resolve this by hand (see the "Match Status" column in the response Sheet).`
    );
    status = "warn";
  }

  if (!info.eventIds.length) {
    lines.push(`Their event answer ("${f.eventLabel}") didn't match a configured event — registration was not marked. Check EVENT_ID_BY_LABEL in the script.`);
    status = "warn";
  }

  return { status, lines };
}

function buildNotificationBody(info) {
  const f = info.form;
  const event = eventLabelsDisplay(f.eventLabel);
  const crossCheck = crossCheckStatus(info);
  const trackerOutreachedBy = info.matchStatus === "matched" ? (info.contact.connector || "(not given)") : null;

  const lines = [
    `${f.name || "(no name given)"} just signed up for "${event || "(no event given)"}" via the Google Form.`,
    "",
    "Sign-up details:",
    `  Year of study: ${f.year || "(not given)"}`,
    `  Gender: ${f.gender || "(not given)"}`,
    `  Country: ${f.country || "(not given)"}`,
    `  Major: ${f.major || "(not given)"}`,
    `  Phone: ${f.rawPhone || "(not given)"}`,
    `  Preferred contact methods: ${f.altMethods || "(not given)"}`,
    `  Other contact info (form): ${f.altContact || "(not given)"}`,
    `  Who connected you? (form response): (not given — this Form doesn't ask)`,
    `  Questions/comments: ${f.questions || "(none)"}`,
  ];
  if (trackerOutreachedBy !== null) {
    lines.push(`  Outreached by (tracker): ${trackerOutreachedBy}`);
  }
  lines.push("", "Tracker cross-check:", ...crossCheck.lines.map(l => `  ${l}`));

  return lines.join("\n");
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function buildNotificationHtml(info) {
  const f = info.form;
  const event = eventLabelsDisplay(f.eventLabel);
  const crossCheck = crossCheckStatus(info);
  const crossCheckColor = crossCheck.status === "ok"
    ? { bg: "#DCFCE7", fg: "#15803D" }
    : { bg: "#FEF3C7", fg: "#92400E" };

  const row = (label, value, note) => `
      <tr>
        <td style="padding:7px 0; color:#6B7280; font-size:13px; vertical-align:top; white-space:nowrap; padding-right:16px;">${escapeHtml(label)}</td>
        <td style="padding:7px 0; color:#1A1D23; font-size:14px;">${escapeHtml(value) || "<span style=\"color:#9AA0AC;\">(not given)</span>"}${note ? ` <span style="color:#9AA0AC; font-size:11px;">${escapeHtml(note)}</span>` : ""}</td>
      </tr>`;

  const trackerOutreachedByRow = info.matchStatus === "matched"
    ? row("Outreached by (tracker)", info.contact.connector, null)
    : "";

  const crossCheckLinesHtml = crossCheck.lines.map(l => `<div style="margin-top:4px;">${escapeHtml(l)}</div>`).join("");

  return `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto;">
  <div style="background:#A8452F; color:#FFFFFF; padding:18px 22px; border-radius:14px 14px 0 0;">
    <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.06em; opacity:0.85;">LIFE @ HKBU Sign-up</div>
    <div style="font-size:21px; font-weight:700; margin-top:4px;">${escapeHtml(f.name) || "(no name given)"}</div>
    ${event ? `<div style="font-size:14px; margin-top:2px; opacity:0.92;">${escapeHtml(event)}</div>` : ""}
  </div>
  <div style="border:1px solid #E2E4E9; border-top:none; border-radius:0 0 14px 14px; padding:20px 22px;">
    <table style="width:100%; border-collapse:collapse;">
      ${row("Year of study", f.year)}
      ${row("Gender", f.gender)}
      ${row("Country", f.country)}
      ${row("Major", f.major)}
      ${row("Phone", f.rawPhone)}
      ${row("Preferred contact methods", f.altMethods)}
      ${row("Other contact info (form)", f.altContact)}
      ${row("Questions/comments", f.questions)}
      ${trackerOutreachedByRow}
    </table>
    <div style="margin-top:16px; padding:12px 14px; border-radius:10px; background:${crossCheckColor.bg}; color:${crossCheckColor.fg}; font-size:13px; line-height:1.5;">
      <div style="font-weight:600; text-transform:uppercase; font-size:11px; letter-spacing:0.04em;">Tracker cross-check</div>
      ${crossCheckLinesHtml}
    </div>
  </div>
</div>`;
}

function normalizePhone(raw) {
  let digits = String(raw || "").replace(/\D/g, "");
  if (digits.length > 8 && digits.startsWith("852")) {
    digits = digits.slice(3);
  }
  return digits;
}

function supabaseHeaders() {
  const key = PropertiesService.getScriptProperties().getProperty("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set in Script Properties");
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    // Supabase's secret-key leak protection blocks requests that look
    // browser-issued; UrlFetchApp's default User-Agent starts with
    // "Mozilla/5.0" and trips that heuristic even though this call is
    // genuinely server-side, so override it explicitly.
    "User-Agent": "ocr-tracker-event-signup-sync-hkbu/1.0 (Google Apps Script)",
  };
}

function findContactsByPhone(normalizedPhone) {
  const url = `${SUPABASE_URL}/rest/v1/contacts?season_id=eq.${SEASON_ID}&select=id,name,phone,connector,source`;
  const res = UrlFetchApp.fetch(url, {
    method: "get",
    headers: supabaseHeaders(),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) {
    throw new Error(`contacts lookup failed: ${res.getContentText()}`);
  }
  const rows = JSON.parse(res.getContentText());
  return rows.filter(c => normalizePhone(c.phone) === normalizedPhone);
}

// HKBU's "Information of other contact methods" question doesn't require
// the strict "ContactMethod: Username" format HKUST's Form does. Splits on
// the first colon if there is one (someone might still type "Instagram:
// handle"); if there's no colon at all, the whole thing is treated as the
// handle with an empty method — which falls back to contacts.phone rather
// than the dedicated contacts.instagram field, same graceful degradation
// HKU's/CUHK's scripts already have for a malformed answer.
function parseAltContact(text) {
  const raw = String(text || "").trim();
  const idx = raw.indexOf(":");
  if (idx === -1) return { method: "", handle: raw };
  return { method: raw.slice(0, idx).trim(), handle: raw.slice(idx + 1).trim() };
}

// Fallback match for respondents with no usable phone: checks the handle
// against both contacts.phone (a member may have typed a WeChat/Instagram
// handle into Quick Add's "Phone / WeChat ID" field, with or without a
// "Method:" prefix) and contacts.instagram, as a substring rather than
// requiring an exact format match.
function findContactsByHandle(handle) {
  const url = `${SUPABASE_URL}/rest/v1/contacts?season_id=eq.${SEASON_ID}&select=id,name,phone,instagram,connector,source`;
  const res = UrlFetchApp.fetch(url, {
    method: "get",
    headers: supabaseHeaders(),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) {
    throw new Error(`contacts lookup failed: ${res.getContentText()}`);
  }
  const rows = JSON.parse(res.getContentText());
  const h = handle.toLowerCase();
  return rows.filter(c =>
    (c.phone || "").toLowerCase().includes(h) || (c.instagram || "").toLowerCase().includes(h)
  );
}

// Which contact methods someone has (the checkbox question, separate from
// the actual handle), the raw "Information of other contact methods"
// answer, and any questions/comments have no dedicated contacts.* column
// (WeChat/email/Other have nowhere else to live — only Instagram gets its
// own field, see createContact() below), so they're folded into
// contacts.progress as a short note instead of being silently dropped.
// Only called on CREATE — never appended to an existing contact's
// progress notes on a match, so it can't clobber something a member
// already wrote there by hand.
function buildExtraNotes(form) {
  const lines = [];
  if (form.country) lines.push(`Country: ${form.country}`);
  if (form.altMethods) lines.push(`Preferred contact methods: ${form.altMethods}`);
  if (form.altContact) lines.push(`Other contact info: ${form.altContact}`);
  if (form.questions) lines.push(`Questions/comments: ${form.questions}`);
  return lines.length ? lines.join("\n") : null;
}

// Called when nobody in the tracker matches this respondent's phone number
// — creates them directly from their Form answers (source: "online", same
// tag signup.html self-submissions get) instead of leaving a member to
// notice the email and Quick Add them by hand.
//
// Unlike HKU's/CUHK's scripts (where the alt-contact question is a
// fallback ONLY consulted when phone is missing), HKBU's phone question is
// REQUIRED — so isInstagram must NOT be gated on `!form.rawPhone`, or an
// Instagram handle in "Information of other contact methods" would always
// be silently dropped (this was a real bug: nearly every respondent has a
// phone number, so the Instagram extraction below never ran). An Instagram
// alt-contact answer always goes into contacts.instagram (its own field on
// the website) regardless of whether a phone was also given; any other
// method (WeChat, email, or no method at all) still falls back to
// contacts.phone ONLY when phone itself is missing — same field Quick
// Add's "Phone / WeChat ID" already uses — and is also preserved verbatim
// in buildExtraNotes() above either way, so a WeChat/email answer is never
// lost outright even without a dedicated column for it.
// contacts.phone is NOT NULL in Supabase, so this must never end up
// passing null there — an empty string satisfies the constraint for
// anyone who gave neither a usable phone nor a usable alt-contact.
//
// contacts.connector ("Outreached by" on the website) is deliberately left
// unset here, same as the other two flexible-form scripts — nobody
// outreached to someone who signed up cold through the Form. This Form
// doesn't have a "How did you get connected?" question at all, so there's
// no last_form_connector to save either.
function createContact(form, altContact) {
  const isInstagram = altContact.method.toLowerCase() === "instagram";
  const payload = {
    name: form.name,
    gender: form.gender || null,
    nationality: form.country || null,
    course: form.major || null,
    year: form.year || null,
    phone: form.rawPhone || (isInstagram ? "" : (form.altContact || "")),
    instagram: isInstagram ? altContact.handle : null,
    progress: buildExtraNotes(form),
    followup_owner_type: null, // point person always starts unassigned — never inferred from connector
    interest_event: true,
    source: "online",
    season_id: SEASON_ID,
  };
  const headers = supabaseHeaders();
  headers.Prefer = "return=representation";
  const res = UrlFetchApp.fetch(`${SUPABASE_URL}/rest/v1/contacts`, {
    method: "post",
    contentType: "application/json",
    headers,
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) {
    throw new Error(`contact create failed: ${res.getContentText()}`);
  }
  return JSON.parse(res.getContentText())[0];
}

// Signing up via the Form means they've REGISTERED for the event — it does
// NOT mean they showed up. That's a separate, later confirmation (done by
// whoever's checking people in at the actual event, via attendance.html),
// tracked by the same row's `attended` column. This only ever sets
// `registered`, deliberately never touching `attended` — a partial PATCH
// body in PostgREST only updates the fields present in it, so an existing
// `attended: true` (someone confirmed present, then re-submitted the Form
// for some reason) is left alone rather than silently overwritten.
function markRegistered(contactId, eventId) {
  const filter = `contact_id=eq.${contactId}&event_id=eq.${eventId}`;
  const existingRes = UrlFetchApp.fetch(
    `${SUPABASE_URL}/rest/v1/event_attendance?${filter}&select=contact_id`,
    { method: "get", headers: supabaseHeaders(), muteHttpExceptions: true }
  );
  if (existingRes.getResponseCode() >= 300) {
    throw new Error(`registration lookup failed: ${existingRes.getContentText()}`);
  }
  const exists = JSON.parse(existingRes.getContentText()).length > 0;

  const payload = {
    contact_id: contactId,
    event_id: eventId,
    registered: true,
    updated_at: new Date().toISOString(),
  };

  const writeRes = UrlFetchApp.fetch(
    exists
      ? `${SUPABASE_URL}/rest/v1/event_attendance?${filter}`
      : `${SUPABASE_URL}/rest/v1/event_attendance`,
    {
      method: exists ? "patch" : "post",
      contentType: "application/json",
      headers: supabaseHeaders(),
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    }
  );
  if (writeRes.getResponseCode() >= 300) {
    throw new Error(`registration write failed: ${writeRes.getContentText()}`);
  }
}

// Someone who signed up via the Form for an event clearly wanted to be
// there, so their tracker profile (the website's edit/new form checkboxes)
// should reflect that too — not just the registration record. event_interest
// has no status column, just a (contact_id, event_id) row meaning
// "interested" — so this is a plain insert, and an already-existing row
// (someone who'd already checked the box manually, or filled the Form
// twice) is expected, not an error: Postgres returns 409 on the duplicate
// primary key, which we treat as success rather than surfacing as a
// failure. A failure here should never block the registration write above —
// it's a secondary nicety, not the primary action — so this never throws;
// worst case a name is missing an interest checkmark that a member can
// tick manually, same as it would've been before this existed.
function markInterested(contactId, eventId) {
  try {
    const res = UrlFetchApp.fetch(
      `${SUPABASE_URL}/rest/v1/event_interest`,
      {
        method: "post",
        contentType: "application/json",
        headers: supabaseHeaders(),
        payload: JSON.stringify({ contact_id: contactId, event_id: eventId }),
        muteHttpExceptions: true,
      }
    );
    if (res.getResponseCode() >= 300 && res.getResponseCode() !== 409) {
      Logger.log(`markInterested: non-fatal write failure for contact ${contactId}, event ${eventId}: ${res.getContentText()}`);
    }
  } catch (err) {
    Logger.log(`markInterested: non-fatal error for contact ${contactId}, event ${eventId}: ${err}`);
  }
}

function writeStatus(sheet, row, text) {
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  let col = headers.indexOf("Match Status") + 1;
  if (col === 0) {
    col = lastCol + 1;
    sheet.getRange(1, col).setValue("Match Status");
  }
  sheet.getRange(row, col).setValue(text);
}
