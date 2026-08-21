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
 * Matching: by normalized WhatsApp number against contacts.phone, scoped to
 * SEASON_ID.
 *   - Exactly one match -> that's them, just mark them attended.
 *   - Zero matches -> nobody's added this person before, so a new contact
 *     is created directly from their Form answers (source: "online"), then
 *     marked attended. No manual Quick Add step needed.
 *   - Multiple matches -> too ambiguous to guess or create a duplicate; a
 *     status is written back to the response row for a member to resolve
 *     by hand instead.
 * If their event answer doesn't match a configured event, the contact is
 * still matched/created as above, just without marking attendance for it.
 *
 * Notification email: every submission also emails NOTIFY_EMAILS below.
 * The Form asks gender, nationality, year, major/school, and "Who
 * connected you?" directly, so the email reports those as typed by the
 * respondent. "Who connected you?" is the one optional question on the
 * Form though, so when it's left blank and there IS an existing tracker
 * match, the connector already on file there (set via Quick Add or the
 * tracker's own Add Contact dialog — both write the same contacts.connector
 * column) is used instead, clearly marked "from tracker" so it's never
 * confused with what the respondent actually typed. If the respondent's
 * answer instead conflicts with what's already on file, that's flagged
 * rather than silently overwritten. Sent via MailApp, so no extra
 * credentials or setup beyond a valid Google account running the script
 * (free quota: 100 emails/day on a plain Gmail account, 1,500/day on
 * Workspace — far above real signup volume).
 *
 * Schema note: contacts.gender must exist for the auto-create path to
 * store it — run this once in Supabase's SQL Editor if it doesn't yet:
 *   alter table contacts add column gender text;
 */

// === CONFIG — fill these in before using ===

const SUPABASE_URL = "https://xyoniqfmujidoxpgcjlo.supabase.co";

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
  "BBQ Night": "b14eee2e-14a2-4b69-9dc9-1ff80af4521d",
  "Speed Friending": "bef8839f-6337-4e07-8d99-84efb4e2df9a",
  "Color Wars": "cd553f56-63cb-4633-91da-4d94e1f23f1f",
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
const Q_CONNECTOR = "Who connected you?";

// Notified on every Form submission. Replace the Ryan placeholder with his
// real address once it's available.
const NOTIFY_EMAILS = [
  "fausfaviola@gmail.com",
  "jaristia1412@gmail.com",
  "ryan-PLACEHOLDER@example.com", // TODO: replace with Ryan's real email
];

// === End of config ===

// The Form's answer is the full option text ("BBQ Night: Wed, Aug 26,
// 7PM..."); this pulls out just the short label ("BBQ Night") for display
// and for looking up EVENT_ID_BY_LABEL. Falls back to the raw answer if it
// doesn't start with any configured label.
function shortEventLabel(answerText) {
  return Object.keys(EVENT_ID_BY_LABEL).find(l => answerText.startsWith(l)) || answerText;
}

function matchEventId(answerText) {
  return EVENT_ID_BY_LABEL[shortEventLabel(answerText)] || null;
}

function onFormSubmit(e) {
  const sheet = e.range.getSheet();
  const row = e.range.getRow();

  // A trigger set up as "From spreadsheet / On form submit" hands us
  // e.namedValues (column header -> [answer]), not e.response — that
  // shape only exists on a trigger bound directly to the Form itself.
  const namedValues = e.namedValues || {};
  const getAnswer = title => {
    const v = namedValues[title];
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
  const eventId = matchEventId(form.eventLabel);

  try {
    let contact = null;

    if (phone) {
      const matches = findContactsByPhone(phone);
      if (matches.length > 1) {
        const names = matches.map(c => c.name).join(", ");
        writeStatus(sheet, row, `Multiple Matches (${names}) — review manually`);
        notifySignup({ form, matchStatus: "multiple", matches, eventId });
        return;
      }
      contact = matches[0] || null;
    }

    const matchStatus = contact ? "matched" : "created";
    if (!contact) {
      contact = createContact(form, form.rawPhone || form.altContact || "");
    }

    let statusText = matchStatus === "matched" ? `Matched: ${contact.name}` : `Added new contact: ${contact.name}`;
    if (eventId) {
      markAttended(contact.id, eventId);
    } else {
      statusText += ` — unrecognized event "${form.eventLabel}", attendance not marked`;
    }
    writeStatus(sheet, row, statusText);
    notifySignup({ form, matchStatus, contact, eventId });
  } catch (err) {
    writeStatus(sheet, row, `Error: ${err.message || err}`);
  }
}

// Never throws — a Mail failure shouldn't clobber the Match Status write
// that already happened in onFormSubmit above.
function notifySignup(info) {
  try {
    if (!NOTIFY_EMAILS.length) return;
    const name = info.form.name || "(no name given)";
    const event = shortEventLabel(info.form.eventLabel);
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

// Falls back to the matched tracker contact's value only when the Form's
// own answer was left blank. Used for "Who connected you?" specifically,
// since it's the one optional Form question — everything else is required.
function mergedField(formValue, contact, contactField) {
  if (formValue) return { value: formValue, fromTracker: false };
  const trackerValue = contact && contact[contactField];
  return trackerValue ? { value: trackerValue, fromTracker: true } : { value: "", fromTracker: false };
}

function mergedConnector(info) {
  const contact = info.matchStatus === "matched" ? info.contact : null;
  return mergedField(info.form.connector, contact, "connector");
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
    const trackerConnector = (c.connector || "").trim().toLowerCase();

    if (formConnector && trackerConnector && formConnector !== trackerConnector) {
      lines.unshift(`Connector on the form ("${f.connector}") differs from what's on file ("${c.connector}") — worth confirming which is right.`);
      status = "warn";
    } else if (!f.connector && c.connector) {
      lines.unshift(`"Who connected them" was left blank on the form — backfilled above from the existing tracker record.`);
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

  if (!info.eventId) {
    lines.push(`Their event answer ("${f.eventLabel}") didn't match a configured event — attendance was not marked. Check EVENT_ID_BY_LABEL in the script.`);
    status = "warn";
  }

  return { status, lines };
}

function buildNotificationBody(info) {
  const f = info.form;
  const event = shortEventLabel(f.eventLabel);
  const contactLine = f.rawPhone
    ? `WhatsApp: ${f.rawPhone}`
    : `WhatsApp: (not given) — alternate contact: ${f.altContact || "(not given)"}`;
  const crossCheck = crossCheckStatus(info);
  const connector = mergedConnector(info);
  const connectorLine = `Who connected them: ${connector.value || "(not given)"}` + (connector.fromTracker ? " (from tracker, not entered on the form)" : "");

  const lines = [
    `${f.name || "(no name given)"} just signed up for "${event || "(no event given)"}" via the Google Form.`,
    "",
    "Sign-up details:",
    `  Gender: ${f.gender || "(not given)"}`,
    `  Nationality: ${f.nationality || "(not given)"}`,
    `  Year: ${f.year || "(not given)"}`,
    `  Major / School: ${f.major || "(not given)"}`,
    `  ${contactLine}`,
    `  ${connectorLine}`,
    "",
    "Tracker cross-check:",
    ...crossCheck.lines.map(l => `  ${l}`),
  ];

  return lines.join("\n");
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function buildNotificationHtml(info) {
  const f = info.form;
  const event = shortEventLabel(f.eventLabel);
  const contactLabel = f.rawPhone ? "WhatsApp" : "Contact (no WhatsApp given)";
  const contactValue = f.rawPhone || f.altContact || "(not given)";
  const connector = mergedConnector(info);
  const crossCheck = crossCheckStatus(info);
  const crossCheckColor = crossCheck.status === "ok"
    ? { bg: "#DCFCE7", fg: "#15803D" }
    : { bg: "#FEF3C7", fg: "#92400E" };

  const row = (label, value, note) => `
      <tr>
        <td style="padding:7px 0; color:#6B7280; font-size:13px; vertical-align:top; white-space:nowrap; padding-right:16px;">${escapeHtml(label)}</td>
        <td style="padding:7px 0; color:#1A1D23; font-size:14px;">${escapeHtml(value) || "<span style=\"color:#9AA0AC;\">(not given)</span>"}${note ? ` <span style="color:#9AA0AC; font-size:11px;">${escapeHtml(note)}</span>` : ""}</td>
      </tr>`;

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
      ${row("Who connected them", connector.value, connector.fromTracker ? "from tracker" : null)}
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

// Called when nobody in the tracker matches this respondent's phone number
// — creates them directly from their Form answers (source: "online", same
// tag signup.html self-submissions get) instead of leaving a member to
// notice the email and Quick Add them by hand.
function createContact(form, phoneValue) {
  const payload = {
    name: form.name,
    gender: form.gender || null,
    nationality: form.nationality || null,
    course: form.major || null,
    year: form.year || null,
    phone: phoneValue || null,
    connector: form.connector || null,
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

function markAttended(contactId, eventId) {
  const filter = `contact_id=eq.${contactId}&event_id=eq.${eventId}`;
  const existingRes = UrlFetchApp.fetch(
    `${SUPABASE_URL}/rest/v1/event_attendance?${filter}&select=contact_id`,
    { method: "get", headers: supabaseHeaders(), muteHttpExceptions: true }
  );
  if (existingRes.getResponseCode() >= 300) {
    throw new Error(`attendance lookup failed: ${existingRes.getContentText()}`);
  }
  const exists = JSON.parse(existingRes.getContentText()).length > 0;

  const payload = {
    contact_id: contactId,
    event_id: eventId,
    attended: true,
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
    throw new Error(`attendance write failed: ${writeRes.getContentText()}`);
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
