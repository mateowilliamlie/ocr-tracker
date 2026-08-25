/**
 * Bridges the "WE ARE HERE @ HKUST" Google Form to the OCR Contact Tracker's
 * Supabase database, so an event RSVP doesn't require manually re-checking the
 * respondent off in attendance.html — and so a respondent nobody has met yet
 * still ends up in the tracker instead of only existing as a Form row.
 *
 * Setup: see the "Event Sign-up Sync" section in README.md. Short version —
 * paste this into Extensions > Apps Script on the Form's linked response
 * Sheet, fill in the CONFIG block below, store the service role key in
 * Script Properties (never here in the code), then add an installable
 * "On form submit" trigger pointing at onFormSubmit.
 *
 * Matching: primarily by normalized WhatsApp number against contacts.phone,
 * scoped to SEASON_ID. When there's no WhatsApp match (or no WhatsApp
 * given at all), falls back to the "If you don't have WhatsApp..." answer
 * — the Form requires that in "ContactMethod: Username" format (e.g.
 * "Instagram: username123"), and the parsed handle is checked as a
 * substring against both contacts.phone (a member may have typed a
 * WeChat/Instagram handle into Quick Add's "Phone / WeChat ID" field,
 * with or without the method prefix) and contacts.instagram.
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
 * Registered vs. attended: submitting the Form only means someone signed
 * up (event_attendance.registered). It is NOT the same as showing up —
 * that's event_attendance.attended, confirmed separately by whoever's
 * checking people in at the actual event via attendance.html. This script
 * never sets `attended` itself. It also inserts an event_interest row
 * (markInterested) for the same event, since signing up clearly implies
 * interest — that's what the tracker's own per-event interest checkboxes
 * read from.
 *
 * Notification email: every submission also emails NOTIFY_EMAILS below.
 * The Form asks gender, nationality, year, major/school, and "How did you
 * get connected?" (social media handle like "Instagram", or a person's
 * name) directly, so the email reports those as typed by the respondent.
 * The connector is deliberately shown as two SEPARATE lines, never
 * merged: "How they got connected (form response)" is exactly what the
 * respondent typed (or "(not given)" — it's the one optional Form
 * question), and "Outreached by (tracker)" is contacts.connector on the
 * matched tracker record — a member met them in person and recorded it
 * via Quick Add/Add Contact/Edit, entirely separate from point person
 * (who's currently assigned to follow up, a later and always-manual
 * step this email doesn't report on). Showing the form's answer and the
 * tracker's outreach record side by side lets the team actually confirm
 * they agree instead of silently trusting one over the other; if they
 * disagree, the cross-check section flags it explicitly. Sent via
 * MailApp, so no extra credentials or setup beyond a
 * valid Google account running the
 * script (free quota: 100 emails/day on a plain Gmail account, 1,500/day
 * on Workspace — far above real signup volume).
 *
 * Schema note: contacts.gender and contacts.instagram must exist for the
 * auto-create path to store them — run this once in Supabase's SQL
 * Editor if they don't yet:
 *   alter table contacts add column gender text;
 *   alter table contacts add column instagram text;
 *
 * Backfill: the trigger only ever fires on new submissions, so responses
 * from before this script (or this matching/auto-create logic) existed
 * were never processed. Run backfillExistingResponses() once manually
 * (Apps Script editor -> pick it from the function dropdown -> Run) to
 * catch those up; it skips rows already resolved to "Matched:" or "Added
 * new contact:", but reprocesses anything else — including a stale
 * pre-auto-create "No Match" status from an older version of this script.
 *
 * If you already ran a backfill before the multi-event fix above existed,
 * rows that picked 2+ events may have only gotten the first one marked
 * attended, and now carry a "Matched:"/"Added new contact:" status that
 * backfillExistingResponses() will skip. Run backfillMissingEvents()
 * once to fix just that gap — it only marks additional events for a
 * contact it can already find by phone, it never creates/matches a new
 * one, so it's safe even for rows that were auto-created (unlike
 * clearing Match Status and reprocessing everything, which could create
 * a duplicate contact for anyone who signed up with no WhatsApp number).
 *
 * Duplicate check + merge: a row that was "Added new contact:" (no phone
 * match at the time) can end up a genuine duplicate of someone met in
 * person during outreach — e.g. they were added with no phone yet, signed
 * up via the Form separately, and only later did a member manually add
 * their phone to the original outreach contact. Every resolved row now
 * also gets its Contact ID written next to it (writeContactId(), so a
 * later re-check can tell "different contact" apart from "same contact,
 * just a nickname/typo in the name"). Use the "OCR Tracker" menu that
 * appears in the Sheet's menu bar once this script is attached (added by
 * onOpen() near the bottom of this file):
 *   - "Check for potential duplicates" runs findPotentialDuplicates(),
 *     which re-matches every resolved row against current contacts data
 *     and writes a "Potential Duplicate" flag onto any row whose best
 *     match is no longer the contact it originally resolved to.
 *   - Select a flagged row, then "Merge duplicate on selected row" runs
 *     mergeDuplicateForSelectedRow() — shows exactly which contact would
 *     be kept vs. deleted and asks for confirmation before doing anything.
 * Merging moves the duplicate's event registration/interest rows and any
 * blank fields onto the kept contact first, then deletes the duplicate —
 * this is NOT reversible, so the confirmation dialog is the only safety
 * net; read it before saying yes. Both menu items can also be run
 * directly from the Apps Script editor's function dropdown, and
 * mergeDuplicateContacts()/performContactMerge() further down remain
 * available for merging an explicit pair of ids by hand (e.g. for a
 * legacy row from before Contact ID existed, which the menu item can't
 * safely handle on its own).
 */

// === CONFIG — fill these in before using ===

const SUPABASE_URL = "https://xyoniqfmujidoxpgcjlo.supabase.co";

// The tab name of the Form's response Sheet (bottom tab in Google Sheets).
// Only used by backfillExistingResponses() below — the live onFormSubmit
// trigger always gets the right sheet from the event object itself.
const RESPONSES_SHEET_NAME = "Form Responses 1";

// HKUST's current season id (Supabase Table Editor -> seasons -> copy the
// row's id). Must be updated whenever a new season starts.
const SEASON_ID = "9b1d4bec-e28c-4729-bf7f-7ec9cad42ab3";

// Maps each event to its Supabase id (Table Editor -> events -> copy each
// row's id for the events belonging to SEASON_ID above). The Form's event
// question answer text includes the full description ("BBQ Night: Wed,
// Aug 26, 7PM @HKUST BBQ Pit - Grill, chat..."), not just the event name,
// so matching below is done by "answer starts with this label", not exact
// equality — keep these labels as just the short event name.
const EVENT_ID_BY_LABEL = {
  "BBQ Night": "bef8839f-6337-4e07-8d99-84efb4e2df9a",
  "Speed Friending": "cd553f56-63cb-4633-91da-4d94e1f23f1f",
  "Color Wars": "b14eee2e-14a2-4b69-9dc9-1ff80af4521d",
};

// Exact Form question titles — must match the Form verbatim.
const Q_NAME = "Full Name";
const Q_GENDER = "Gender";
const Q_NATIONALITY = "Nationality";
const Q_PHONE = "WhatsApp Number";
const Q_YEAR = "Year";
const Q_MAJOR = "Major (if you don't have one, put your school)";
const Q_EVENT = "Which event would you like to sign up for?";
const Q_ALT_CONTACT = "If you don't have WhatsApp, how can we contact you?";
const Q_CONNECTOR = "How did you get connected?";

// Notified on every Form submission.
const NOTIFY_EMAILS = [
  "fausfaviola@gmail.com",
  // "jaristia1412@gmail.com",
  // "rchud2007@gmail.com",
];

// === End of config ===

// The event question is a checkboxes field, so picking more than one event
// gives an answer like "BBQ Night: Wed, Aug 26...vibes with us!, Speed
// Friending: Fri, Aug 28...find your community" — Google Forms joins
// multiple selections with ", ", and each option's own text already has
// commas in it, so a naive split on "," would shred it. Instead, check for
// each configured label as a substring (followed by ":", matching the
// "Label: description" shape every option uses) — this finds every event
// they picked regardless of order or how many.
function matchedEventLabels(answerText) {
  return Object.keys(EVENT_ID_BY_LABEL).filter(l => answerText.includes(`${l}:`));
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
  // "actual key starts with this Q_ constant" because someone editing a
  // Form question to add usage instructions or a typo fix (e.g. appending
  // "\nPlease type in the format of..." to the alt-contact question) changes
  // its exact title — this happened for real: Q_ALT_CONTACT stopped
  // matching the moment that instructional text was added to the question,
  // so getAnswer() silently returned "" and every alt-contact answer
  // (Instagram/WeChat/email) was lost even though respondents typed one.
  // The Q_ constants only need to stay a prefix of the real question now,
  // not match it exactly — much less likely to break on a wording tweak.
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
    gender: getAnswer(Q_GENDER).trim(),
    nationality: getAnswer(Q_NATIONALITY).trim(),
    year: getAnswer(Q_YEAR).trim(),
    major: getAnswer(Q_MAJOR).trim(),
    eventLabel: getAnswer(Q_EVENT).trim(),
    rawPhone: getAnswer(Q_PHONE).trim(),
    altContact: getAnswer(Q_ALT_CONTACT).trim(),
    connector: getAnswer(Q_CONNECTOR).trim(),
  };
  const phone = normalizePhone(form.rawPhone);
  const altContact = parseAltContact(form.altContact);
  const eventIds = matchedEventIds(form.eventLabel);

  try {
    let matches = [];
    if (phone) {
      matches = findContactsByPhone(phone);
    }
    // No WhatsApp match (or no WhatsApp given at all) — try the alt-contact
    // handle (e.g. "Instagram: username123") against the tracker's phone
    // field, since that's the only field on that side that could hold it.
    // Only for handles with enough characters to mean something — a
    // one/two-character handle risks matching unrelated phone numbers.
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

    // A MATCHED contact's own tracker record (contacts.connector) might be
    // stale or simply about someone different from who they said connected
    // them on the Form — e.g. a member met them in person and is already
    // their point person, but the respondent separately named someone else
    // here. That form answer was previously only visible in this one-time
    // email/Sheet row; saving it lets the website show both side by side
    // instead of silently losing the form's answer once this email scrolls
    // out of an inbox. Always the LATEST form answer, so a second
    // submission overwrites rather than stacking.
    if (form.connector) {
      updateLastFormConnector(contact.id, form.connector);
    }

    let statusText = matchStatus === "matched" ? `Matched: ${contact.name}` : `Added new contact: ${contact.name}`;
    if (eventIds.length) {
      eventIds.forEach(id => { markRegistered(contact.id, id); markInterested(contact.id, id); });
      if (eventIds.length > 1) statusText += ` — ${eventIds.length} events`;
    } else {
      statusText += ` — unrecognized event "${form.eventLabel}", not marked registered`;
    }
    writeStatus(sheet, row, statusText);
    writeContactId(sheet, row, contact.id);
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
// are skipped (anything else, including a stale pre-auto-create "No
// Match" status, gets reprocessed).
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
    // Only skip rows the CURRENT logic already resolved to a real contact —
    // not rows carrying a stale status from an older script version (e.g.
    // "No Match — not found in tracker, add manually", written before the
    // auto-create path existed). Those need reprocessing, not skipping.
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

// One-off fix for rows that picked MORE THAN ONE event but, under the
// multi-event bug (fixed above), only got registered for the
// first one. Deliberately narrower than backfillExistingResponses: this
// NEVER creates or matches a new contact — it only looks up an existing
// contact by phone and marks any additional events found. That makes it
// safe to run even on rows that already got auto-created, since it can't
// produce a duplicate contact the way clearing Match Status and
// reprocessing everything could for anyone who signed up with no
// WhatsApp number (there'd be no phone to match them back to their own
// record, so it'd create a second one instead of fixing anything).
// Rows with no phone are logged for manual follow-up instead of guessed.
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

// Catches the case where a row was originally "Added new contact:" (or
// "Matched:") because the respondent's phone/alt-contact didn't match
// anyone in the tracker AT THE TIME — e.g. they were met in person during
// outreach with no phone recorded yet, then separately signed up via the
// Form (creating a second, duplicate "online" contact), and only later did
// a member manually add their phone number to the original outreach
// contact. From that point on, re-matching this row would find the
// ORIGINAL contact, not the duplicate the Form actually created — but
// nothing re-checks old rows automatically, so the duplicate just sits
// there unnoticed.
//
// This re-matches EVERY row (unlike backfillExistingResponses, which
// skips already-resolved rows) using CURRENT contacts data, and flags any
// row whose best current match is a DIFFERENT contact than what this row
// originally resolved to. For rows with a stored Contact ID (written by
// writeContactId() since that tracking was added), the comparison is
// exact-id, not name text — two different people can share a name, so
// only an id is a safe enough signal to offer the one-click merge below.
// Flags into a "Potential Duplicate" column right on the row (format:
// `DUPLICATE? original=<id> current=<id> ("<name>")`), which is what
// "Merge duplicate on selected row" (see the onOpen() menu near the
// bottom of this file) reads back out — select the flagged row, run that
// menu item, and it'll ask you to confirm before merging.
//
// Rows from before Contact ID existed have no reliable id to offer a
// menu-driven merge for (a name string alone isn't a safe thing to
// delete a contact based on), so those are still flagged by name as a
// fallback, prefixed "REVIEW (legacy row)" — read the log and use
// mergeDuplicateContacts() with explicit ids for those instead.
//
// Deliberately READ-ONLY beyond writing that one flag column — it never
// merges or deletes anything itself.
function findPotentialDuplicates() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RESPONSES_SHEET_NAME);
  if (!sheet) throw new Error(`No sheet named "${RESPONSES_SHEET_NAME}" — check RESPONSES_SHEET_NAME in the CONFIG block.`);

  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const nameCol = headers.indexOf(Q_NAME);
  const phoneCol = headers.indexOf(Q_PHONE);
  const altContactCol = headers.indexOf(Q_ALT_CONTACT);
  const statusCol = headers.indexOf("Match Status");
  const contactIdCol = headers.indexOf("Contact ID");
  if (phoneCol === -1) {
    throw new Error("Couldn't find the phone column — check Q_PHONE matches the Sheet's header row.");
  }

  // "Matched: Jane Lee" / "Added new contact: Jane Lee — 2 events" -> "Jane Lee"
  const recordedNameFrom = statusText => {
    const m = /^(?:Matched|Added new contact):\s*(.+?)(?:\s*—.*)?$/.exec(statusText);
    return m ? m[1].trim() : null;
  };

  const flagged = [];
  let checked = 0;

  for (let i = 1; i < data.length; i++) {
    const currentStatus = statusCol !== -1 ? String(data[i][statusCol] || "") : "";
    const recordedName = recordedNameFrom(currentStatus);
    if (!recordedName) continue; // unresolved/error/multiple-match rows aren't this function's job

    const rowNum = i + 1;
    const who = nameCol !== -1 ? String(data[i][nameCol] || "") : `row ${rowNum}`;
    const recordedId = contactIdCol !== -1 ? String(data[i][contactIdCol] || "").trim() : "";
    const phone = normalizePhone(String(data[i][phoneCol] || ""));
    const altHandle = altContactCol !== -1 ? parseAltContact(String(data[i][altContactCol] || "")).handle : "";

    let matches = phone ? findContactsByPhone(phone) : [];
    if (matches.length === 0 && altHandle.length >= 3) {
      matches = findContactsByHandle(altHandle);
    }
    checked++;

    if (matches.length > 1) {
      flagged.push(`${who} (row ${rowNum}): now matches ${matches.length} contacts (${matches.map(m => m.name).join(", ")}) — review manually.`);
      writeColumn(sheet, rowNum, "Potential Duplicate", `MULTIPLE MATCHES — review manually: ${matches.map(m => m.name).join(", ")}`);
    } else if (matches.length === 1 && recordedId && matches[0].id !== recordedId) {
      flagged.push(
        `${who} (row ${rowNum}): now matches "${matches[0].name}" (id ${matches[0].id}), ` +
        `originally resolved to contact id ${recordedId} — check for a duplicate and merge.`
      );
      writeColumn(sheet, rowNum, "Potential Duplicate", `DUPLICATE? original=${recordedId} current=${matches[0].id} ("${matches[0].name}")`);
    } else if (matches.length === 1 && !recordedId && matches[0].name.trim().toLowerCase() !== recordedName.toLowerCase()) {
      flagged.push(
        `${who} (row ${rowNum}): now matches "${matches[0].name}" (id ${matches[0].id}), ` +
        `but was originally recorded as "${recordedName}" (legacy row, no stored id) — check for a duplicate and merge by hand.`
      );
      writeColumn(sheet, rowNum, "Potential Duplicate", `REVIEW (legacy row): now matches "${matches[0].name}" (id ${matches[0].id}) instead of "${recordedName}"`);
    } else {
      writeColumn(sheet, rowNum, "Potential Duplicate", "");
    }
    Utilities.sleep(150); // gentle pacing against Supabase rate limits
  }

  Logger.log(`Checked ${checked} resolved row(s). ` +
    (flagged.length
      ? `${flagged.length} potential duplicate(s) — also written into the "Potential Duplicate" column on each flagged row:\n${flagged.join("\n")}`
      : "No potential duplicates found."));
}

// Which of a duplicate pair's fields are safe to copy onto the primary —
// but ONLY when the primary's own value is blank, so this can never
// clobber something a member already entered. Deliberately excludes:
// name/phone/source/season_id (the primary's own identity — the whole
// point of picking a primary), reminder_date/reminder_note/followed_up
// (member-driven workflow state that has no business coming from a
// throwaway auto-created duplicate), and followup_owner_type/other
// (point person must stay explicitly assigned by a member, never
// silently inferred via a merge — same rule createContact() already
// follows for brand-new contacts).
const MERGE_FILLABLE_FIELDS = [
  "nationality", "gender", "course", "age", "year", "birthday",
  "instagram", "faith_background", "suggested_connection",
  "connector", "last_form_connector",
];
const MERGE_BOOLEAN_OR_FIELDS = ["interest_event", "interest_lg", "interest_church"];

function fetchContact(id) {
  const res = UrlFetchApp.fetch(`${SUPABASE_URL}/rest/v1/contacts?id=eq.${id}&select=*`, {
    method: "get", headers: supabaseHeaders(), muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) throw new Error(`contact fetch failed: ${res.getContentText()}`);
  const rows = JSON.parse(res.getContentText());
  if (!rows.length) throw new Error(`No contact found with id ${id}`);
  return rows[0];
}

function isBlank(v) {
  return v === null || v === undefined || v === "";
}

// Builds ONLY the fields that need to change on the primary — an empty
// object means the primary already had everything, nothing to PATCH.
function buildMergedContactPayload(primary, duplicate) {
  const payload = {};
  MERGE_FILLABLE_FIELDS.forEach(f => {
    if (isBlank(primary[f]) && !isBlank(duplicate[f])) payload[f] = duplicate[f];
  });
  MERGE_BOOLEAN_OR_FIELDS.forEach(f => {
    if (duplicate[f] && !primary[f]) payload[f] = true;
  });
  if (duplicate.progress && duplicate.progress.trim()) {
    const dupNote = `[Merged from duplicate contact ${duplicate.id}]\n${duplicate.progress.trim()}`;
    payload.progress = primary.progress ? `${primary.progress}\n\n${dupNote}` : dupNote;
  }
  return payload;
}

function fetchEventAttendance(contactId) {
  const res = UrlFetchApp.fetch(`${SUPABASE_URL}/rest/v1/event_attendance?contact_id=eq.${contactId}&select=*`, {
    method: "get", headers: supabaseHeaders(), muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) throw new Error(`event_attendance fetch failed: ${res.getContentText()}`);
  return JSON.parse(res.getContentText());
}

function fetchEventInterest(contactId) {
  const res = UrlFetchApp.fetch(`${SUPABASE_URL}/rest/v1/event_interest?contact_id=eq.${contactId}&select=*`, {
    method: "get", headers: supabaseHeaders(), muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) throw new Error(`event_interest fetch failed: ${res.getContentText()}`);
  return JSON.parse(res.getContentText());
}

// event_attendance's primary key is (contact_id, event_id), so a straight
// reassignment can't just PATCH contact_id when the primary ALREADY has a
// row for that same event — that would collide. Two cases:
//   - Primary has no row for this event yet -> just reassign the
//     duplicate's row directly (keeps its own updated_at history).
//   - Primary already has a row -> OR the registered/attended flags
//     together (true means it genuinely happened under one identity or
//     the other, so this can only ever promote false -> true, never the
//     reverse), then delete the now-redundant duplicate row.
function mergeEventAttendance(primaryId, duplicateId) {
  const primaryByEvent = {};
  fetchEventAttendance(primaryId).forEach(r => { primaryByEvent[r.event_id] = r; });

  fetchEventAttendance(duplicateId).forEach(dupRow => {
    const existing = primaryByEvent[dupRow.event_id];
    if (!existing) {
      const res = UrlFetchApp.fetch(
        `${SUPABASE_URL}/rest/v1/event_attendance?contact_id=eq.${duplicateId}&event_id=eq.${dupRow.event_id}`,
        {
          method: "patch",
          contentType: "application/json",
          headers: supabaseHeaders(),
          payload: JSON.stringify({ contact_id: primaryId }),
          muteHttpExceptions: true,
        }
      );
      if (res.getResponseCode() >= 300) throw new Error(`event_attendance reassign failed: ${res.getContentText()}`);
      return;
    }

    const mergedRegistered = existing.registered || dupRow.registered;
    const mergedAttended = existing.attended || dupRow.attended;
    if (mergedRegistered !== existing.registered || mergedAttended !== existing.attended) {
      const res = UrlFetchApp.fetch(
        `${SUPABASE_URL}/rest/v1/event_attendance?contact_id=eq.${primaryId}&event_id=eq.${dupRow.event_id}`,
        {
          method: "patch",
          contentType: "application/json",
          headers: supabaseHeaders(),
          payload: JSON.stringify({ registered: mergedRegistered, attended: mergedAttended }),
          muteHttpExceptions: true,
        }
      );
      if (res.getResponseCode() >= 300) throw new Error(`event_attendance flag-merge failed: ${res.getContentText()}`);
    }
    const delRes = UrlFetchApp.fetch(
      `${SUPABASE_URL}/rest/v1/event_attendance?contact_id=eq.${duplicateId}&event_id=eq.${dupRow.event_id}`,
      { method: "delete", headers: supabaseHeaders(), muteHttpExceptions: true }
    );
    if (delRes.getResponseCode() >= 300) throw new Error(`event_attendance duplicate-row delete failed: ${delRes.getContentText()}`);
  });
}

// event_interest has no status column, just a (contact_id, event_id) row
// meaning "interested" — so reassigning is a plain insert under the
// primary's id per duplicate row, and a 409 (primary already interested
// in that event) is expected, not an error, same as markInterested()
// above treats it. The duplicate's own rows are cleared afterward so
// deleting the duplicate contact below can't hit a foreign-key error.
function mergeEventInterest(primaryId, duplicateId) {
  fetchEventInterest(duplicateId).forEach(dupRow => {
    const res = UrlFetchApp.fetch(`${SUPABASE_URL}/rest/v1/event_interest`, {
      method: "post",
      contentType: "application/json",
      headers: supabaseHeaders(),
      payload: JSON.stringify({ contact_id: primaryId, event_id: dupRow.event_id }),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() >= 300 && res.getResponseCode() !== 409) {
      throw new Error(`event_interest reassign failed: ${res.getContentText()}`);
    }
  });
  const delRes = UrlFetchApp.fetch(`${SUPABASE_URL}/rest/v1/event_interest?contact_id=eq.${duplicateId}`, {
    method: "delete", headers: supabaseHeaders(), muteHttpExceptions: true,
  });
  if (delRes.getResponseCode() >= 300) throw new Error(`event_interest duplicate cleanup failed: ${delRes.getContentText()}`);
}

// Merges a confirmed duplicate pair (found via findPotentialDuplicates(),
// then eyeballed by a member — this function never guesses which contact
// is the "real" one) and DELETES the duplicate contact. This is
// destructive and NOT reversible from within the script, so:
//   - It takes no parameters and is never called by any other function
//     here — edit PRIMARY_CONTACT_ID/DUPLICATE_CONTACT_ID below by hand
//     and run it deliberately from the Apps Script editor each time,
//     rather than something that could fire automatically.
//   - It refuses to run at all until both ids are actually filled in.
//   - Event attendance/registration/interest are fully moved onto the
//     primary first (see mergeEventAttendance/mergeEventInterest above)
//     before the duplicate contact itself is deleted, so nothing about
//     what they signed up for or attended is lost.
//   - Any blank field on the primary gets filled from the duplicate (see
//     MERGE_FILLABLE_FIELDS above) — never overwrites something the
//     primary already had.
// Before running: open both contacts in the tracker yourself and confirm
// they really are the same person and which one should survive as
// PRIMARY_CONTACT_ID. There is no undo once the duplicate is deleted.
function mergeDuplicateContacts() {
  const PRIMARY_CONTACT_ID = "REPLACE_WITH_PRIMARY_CONTACT_ID";
  const DUPLICATE_CONTACT_ID = "REPLACE_WITH_DUPLICATE_CONTACT_ID";

  if (PRIMARY_CONTACT_ID.startsWith("REPLACE_WITH") || DUPLICATE_CONTACT_ID.startsWith("REPLACE_WITH")) {
    throw new Error("Edit PRIMARY_CONTACT_ID / DUPLICATE_CONTACT_ID inside mergeDuplicateContacts() before running.");
  }
  performContactMerge(PRIMARY_CONTACT_ID, DUPLICATE_CONTACT_ID);
}

// The actual merge mechanics, shared by mergeDuplicateContacts() (manual,
// edit-the-constants entry point above) and mergeDuplicateForSelectedRow()
// (menu-driven entry point below). Throws on any failure partway through
// so the caller's error surfaces rather than leaving a silent partial
// merge — see each step's own comment (mergeEventAttendance,
// mergeEventInterest, buildMergedContactPayload) for what "merge" means
// for that piece of data.
function performContactMerge(primaryId, duplicateId) {
  if (primaryId === duplicateId) {
    throw new Error("Primary and duplicate are the same contact — nothing to merge.");
  }

  const primary = fetchContact(primaryId);
  const duplicate = fetchContact(duplicateId);
  Logger.log(`Merging "${duplicate.name}" (${duplicateId}) into "${primary.name}" (${primaryId})...`);

  mergeEventAttendance(primaryId, duplicateId);
  Logger.log("Event attendance/registration merged.");

  mergeEventInterest(primaryId, duplicateId);
  Logger.log("Event interest merged.");

  const fieldPayload = buildMergedContactPayload(primary, duplicate);
  if (Object.keys(fieldPayload).length) {
    const res = UrlFetchApp.fetch(`${SUPABASE_URL}/rest/v1/contacts?id=eq.${primaryId}`, {
      method: "patch",
      contentType: "application/json",
      headers: supabaseHeaders(),
      payload: JSON.stringify(fieldPayload),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() >= 300) throw new Error(`primary contact field merge failed: ${res.getContentText()}`);
    Logger.log(`Filled in on primary: ${Object.keys(fieldPayload).join(", ")}`);
  } else {
    Logger.log("No blank fields to fill in on primary from the duplicate.");
  }

  const delRes = UrlFetchApp.fetch(`${SUPABASE_URL}/rest/v1/contacts?id=eq.${duplicateId}`, {
    method: "delete", headers: supabaseHeaders(), muteHttpExceptions: true,
  });
  if (delRes.getResponseCode() >= 300) throw new Error(`duplicate contact delete failed: ${delRes.getContentText()}`);

  Logger.log(`Done — "${duplicate.name}" merged into "${primary.name}" and the duplicate record was deleted.`);
  return { primary, duplicate };
}

// Adds a "OCR Tracker" menu to the Sheet's menu bar (shows automatically
// whenever the Sheet is opened — this is a Google Apps Script "simple
// trigger", no installable trigger needed for onOpen specifically). This
// is what makes the duplicate flag actionable right from the Sheet
// instead of needing the script editor at all.
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("OCR Tracker")
    .addItem("Check for potential duplicates", "findPotentialDuplicates")
    .addItem("Merge duplicate on selected row", "mergeDuplicateForSelectedRow")
    .addToUi();
}

// Run after selecting a cell in a row that findPotentialDuplicates()
// flagged (its "Potential Duplicate" column starts with "DUPLICATE?" —
// the "REVIEW (legacy row)"/"MULTIPLE MATCHES" flags aren't handled here,
// see findPotentialDuplicates()'s own comment for why). Reads the two
// contact ids straight off that cell, shows exactly who'll be kept vs.
// deleted and asks for confirmation, then calls performContactMerge()
// only if you confirm. The "current" match (found by re-matching this
// row's phone/alt-contact against contacts data right now) is always
// treated as the primary to KEEP, and "original" (whoever this row
// resolved to back when it first ran) as the duplicate to remove — that
// matches the actual bug this exists for (met in person with no phone
// yet -> signed up separately -> phone added to the real contact later),
// but double-check the confirmation dialog names the right two people
// before saying yes regardless.
function mergeDuplicateForSelectedRow() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RESPONSES_SHEET_NAME);
  if (!sheet) { ui.alert(`No sheet named "${RESPONSES_SHEET_NAME}" — check RESPONSES_SHEET_NAME in the CONFIG block.`); return; }

  const activeSheet = SpreadsheetApp.getActiveSheet();
  if (activeSheet.getSheetId() !== sheet.getSheetId()) {
    ui.alert(`Select a row on the "${RESPONSES_SHEET_NAME}" sheet first.`);
    return;
  }
  const row = activeSheet.getActiveRange().getRow();
  if (row === 1) { ui.alert("That's the header row — select an actual response row instead."); return; }

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const dupCol = headers.indexOf("Potential Duplicate") + 1;
  if (dupCol === 0) { ui.alert('No "Potential Duplicate" column yet — run "Check for potential duplicates" first.'); return; }

  const cellText = String(sheet.getRange(row, dupCol).getValue() || "");
  const m = /^DUPLICATE\? original=(\S+) current=(\S+) \("(.+)"\)$/.exec(cellText);
  if (!m) {
    ui.alert(
      cellText
        ? `This row's flag isn't a mergeable duplicate:\n\n"${cellText}"\n\nSee findPotentialDuplicates()'s comment — legacy rows and multiple-match rows need manual handling instead.`
        : "This row isn't flagged as a potential duplicate. Run \"Check for potential duplicates\" first if you haven't yet."
    );
    return;
  }

  const originalId = m[1], currentId = m[2], currentName = m[3];
  let original;
  try {
    original = fetchContact(originalId);
  } catch (err) {
    ui.alert(`Couldn't look up the original contact (id ${originalId}): ${err.message || err}`);
    return;
  }

  const response = ui.alert(
    "Merge duplicate contact?",
    `This row originally created/matched "${original.name}" (id ${originalId}), but re-matching it now finds ` +
    `"${currentName}" (id ${currentId}) instead — that's almost always the real, pre-existing contact.\n\n` +
    `KEEP: "${currentName}"\nDELETE: "${original.name}" (its event sign-ups and any info it has get moved onto "${currentName}" first)\n\n` +
    `This cannot be undone. Continue?`,
    ui.ButtonSet.YES_NO
  );
  if (response !== ui.Button.YES) { Logger.log("Merge cancelled by user."); return; }

  try {
    performContactMerge(currentId, originalId);
    writeColumn(sheet, row, "Potential Duplicate", `MERGED: "${original.name}" (${originalId}) -> "${currentName}" (${currentId})`);
    ui.alert(`Done — "${original.name}" was merged into "${currentName}" and deleted.`);
  } catch (err) {
    ui.alert(`Merge failed: ${err.message || err}\n\nCheck the Executions log for details on how far it got.`);
  }
}

// Never throws — a Mail failure shouldn't clobber the Match Status write
// that already happened in onFormSubmit above.
function notifySignup(info) {
  try {
    if (!NOTIFY_EMAILS.length) return;
    const name = info.form.name || "(no name given)";
    const event = eventLabelsDisplay(info.form.eventLabel);
    const subject = `OCR Event Sign-up: ${name}` + (event ? ` — ${event}` : "");
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
// a status ("ok"/"warn") plus one or more lines of detail.
function crossCheckStatus(info) {
  const f = info.form;
  const lines = [];
  let status = "ok";

  if (info.matchStatus === "matched") {
    const c = info.contact;
    lines.push(`How they entered the tracker: ${sourceLabel(c.source)}`);
    const formConnector = f.connector.trim().toLowerCase();
    const trackerOutreachedBy = (c.connector || "").trim().toLowerCase();

    // Compared against contacts.connector ("Outreached by" on the website —
    // who a member met in person and recorded, separate from the tracker's
    // point person assignment) since that's the same "who connected them"
    // question the Form is asking, just from the tracker's own side.
    if (formConnector && trackerOutreachedBy && formConnector !== trackerOutreachedBy) {
      lines.unshift(`They and the tracker disagree on who connected them — worth confirming which is right.`);
      status = "warn";
    }
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
  const contactLine = f.rawPhone
    ? `WhatsApp: ${f.rawPhone}`
    : `WhatsApp: (not given) — alternate contact: ${f.altContact || "(not given)"}`;
  const crossCheck = crossCheckStatus(info);
  // Always shown separately, never merged — the form answer is what THEY
  // say connected them; the tracker value is contacts.connector
  // ("Outreached by" on the website — a member met them in person and
  // recorded it via Quick Add/Add Contact/Edit). They should usually
  // agree with the form, but showing both lets the team actually confirm
  // that instead of assuming it.
  const trackerOutreachedBy = info.matchStatus === "matched" ? (info.contact.connector || "(not given)") : null;

  const lines = [
    `${f.name || "(no name given)"} just signed up for "${event || "(no event given)"}" via the Google Form.`,
    "",
    "Sign-up details:",
    `  Gender: ${f.gender || "(not given)"}`,
    `  Nationality: ${f.nationality || "(not given)"}`,
    `  Year: ${f.year || "(not given)"}`,
    `  Major / School: ${f.major || "(not given)"}`,
    `  ${contactLine}`,
    `  How they got connected (form response): ${f.connector || "(not given)"}`,
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
  const contactLabel = f.rawPhone ? "WhatsApp" : "Contact (no WhatsApp given)";
  const contactValue = f.rawPhone || f.altContact || "(not given)";
  const crossCheck = crossCheckStatus(info);
  const crossCheckColor = crossCheck.status === "ok"
    ? { bg: "#DCFCE7", fg: "#15803D" }
    : { bg: "#FEF3C7", fg: "#92400E" };

  const row = (label, value, note) => `
      <tr>
        <td style="padding:7px 0; color:#6B7280; font-size:13px; vertical-align:top; white-space:nowrap; padding-right:16px;">${escapeHtml(label)}</td>
        <td style="padding:7px 0; color:#1A1D23; font-size:14px;">${escapeHtml(value) || "<span style=\"color:#9AA0AC;\">(not given)</span>"}${note ? ` <span style="color:#9AA0AC; font-size:11px;">${escapeHtml(note)}</span>` : ""}</td>
      </tr>`;

  // Always shown separately, never merged — the form answer is what THEY
  // say connected them; the tracker value is contacts.connector
  // ("Outreached by" on the website), shown only when there's a tracker
  // record to compare against.
  const trackerOutreachedByRow = info.matchStatus === "matched"
    ? row("Outreached by (tracker)", info.contact.connector, null)
    : "";

  const crossCheckLinesHtml = crossCheck.lines.map(l => `<div style="margin-top:4px;">${escapeHtml(l)}</div>`).join("");

  return `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto;">
  <div style="background:#A8452F; color:#FFFFFF; padding:18px 22px; border-radius:14px 14px 0 0;">
    <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.06em; opacity:0.85;">OCR Event Sign-up</div>
    <div style="font-size:21px; font-weight:700; margin-top:4px;">${escapeHtml(f.name) || "(no name given)"}</div>
    ${event ? `<div style="font-size:14px; margin-top:2px; opacity:0.92;">${escapeHtml(event)}</div>` : ""}
  </div>
  <div style="border:1px solid #E2E4E9; border-top:none; border-radius:0 0 14px 14px; padding:20px 22px;">
    <table style="width:100%; border-collapse:collapse;">
      ${row("Gender", f.gender)}
      ${row("Nationality", f.nationality)}
      ${row("Year", f.year)}
      ${row("Major / School", f.major)}
      ${row(contactLabel, contactValue)}
      ${row("How they got connected (form response)", f.connector, null)}
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
    "User-Agent": "ocr-tracker-event-signup-sync/1.0 (Google Apps Script)",
  };
}

function findContactsByPhone(normalizedPhone) {
  const url = `${SUPABASE_URL}/rest/v1/contacts?season_id=eq.${SEASON_ID}&select=id,name,phone,connector,source,followup_owner_type,followup_owner_other,suggested_connection`;
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

// The Form's "If you don't have WhatsApp..." question now asks for
// "ContactMethod: Username" (e.g. "Instagram: username123"). Splits on the
// first colon; if there's no colon at all (old-format or malformed
// answers), the whole thing is treated as the handle with an empty method.
function parseAltContact(text) {
  const raw = String(text || "").trim();
  const idx = raw.indexOf(":");
  if (idx === -1) return { method: "", handle: raw };
  return { method: raw.slice(0, idx).trim(), handle: raw.slice(idx + 1).trim() };
}

// Fallback match for respondents with no WhatsApp number: checks the
// handle against both contacts.phone (a member may have typed a WeChat/
// Instagram handle into Quick Add's "Phone / WeChat ID" field, with or
// without a "Method:" prefix) and contacts.instagram, as a substring
// rather than requiring an exact format match.
function findContactsByHandle(handle) {
  const url = `${SUPABASE_URL}/rest/v1/contacts?season_id=eq.${SEASON_ID}&select=id,name,phone,instagram,connector,source,followup_owner_type,followup_owner_other,suggested_connection`;
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

// Called when nobody in the tracker matches this respondent's phone number
// — creates them directly from their Form answers (source: "online", same
// tag signup.html self-submissions get) instead of leaving a member to
// notice the email and Quick Add them by hand. An Instagram alt-contact
// answer goes into contacts.instagram (its own field on the website); any
// other method (WeChat, email, or no method at all) falls back to the
// same contacts.phone field Quick Add's "Phone / WeChat ID" already uses.
// contacts.phone is NOT NULL in Supabase, so this must never end up
// passing null there — an empty string satisfies the constraint for
// anyone who gave neither a WhatsApp number nor a usable alt-contact.
//
// contacts.connector ("Outreached by" on the website) is deliberately left
// unset here — it's purely day-outreach/website info (who met this person
// in person and typed themselves into Quick Add/Add Contact/Edit), and
// nobody outreached to someone who signed up cold through the Form. Their
// own answer to "How did you get connected?" goes to
// contacts.last_form_connector instead, via the caller's
// updateLastFormConnector() call right after this returns — never into
// connector, which would silently relabel form data as if it were
// outreach data.
function createContact(form, altContact) {
  const isInstagram = !form.rawPhone && altContact.method.toLowerCase() === "instagram";
  const payload = {
    name: form.name,
    gender: form.gender || null,
    nationality: form.nationality || null,
    course: form.major || null,
    year: form.year || null,
    phone: form.rawPhone || (isInstagram ? "" : (form.altContact || "")),
    instagram: isInstagram ? altContact.handle : null,
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

// Saves what THIS respondent typed for "How did you get connected?" onto the
// matched/created contact's own record (contacts.last_form_connector),
// separate from contacts.connector (the tracker's own point-person field,
// set via Quick Add/Add Contact/Edit) — the two can legitimately disagree
// (a member's already the point person on file, but the respondent named
// someone else), and the website flags that instead of one silently
// overwriting the other. Never throws: a failure here shouldn't block the
// registration/interest writes, which matter more.
function updateLastFormConnector(contactId, formConnector) {
  try {
    const res = UrlFetchApp.fetch(
      `${SUPABASE_URL}/rest/v1/contacts?id=eq.${contactId}`,
      {
        method: "patch",
        contentType: "application/json",
        headers: supabaseHeaders(),
        payload: JSON.stringify({ last_form_connector: formConnector }),
        muteHttpExceptions: true,
      }
    );
    if (res.getResponseCode() >= 300) {
      Logger.log(`updateLastFormConnector: non-fatal write failure for contact ${contactId}: ${res.getContentText()}`);
    }
  } catch (err) {
    Logger.log(`updateLastFormConnector: non-fatal error for contact ${contactId}: ${err}`);
  }
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

// Shared by writeStatus/writeContactId/writePotentialDuplicate below —
// finds (or creates) a column by its header name and writes one cell.
function writeColumn(sheet, row, headerName, text) {
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  let col = headers.indexOf(headerName) + 1;
  if (col === 0) {
    col = lastCol + 1;
    sheet.getRange(1, col).setValue(headerName);
  }
  sheet.getRange(row, col).setValue(text);
}

function writeStatus(sheet, row, text) {
  writeColumn(sheet, row, "Match Status", text);
}

// Written every time a row resolves to a real contact (matched or
// created). The Match Status column only ever recorded a NAME — not
// precise enough to safely automate anything later, since two different
// people can share a name. Having the actual id on the row is what makes
// findPotentialDuplicates()/the "Merge duplicate on selected row" menu
// item (see near the bottom of this file) able to identify a duplicate
// pair exactly rather than guessing from text.
function writeContactId(sheet, row, contactId) {
  writeColumn(sheet, row, "Contact ID", contactId);
}
