// Shared season-page tab bar (Tracker / Attendance / Calendar / Dashboard).
// Single source of truth for cross-page navigation — included the same way
// as theme.js/loading.js on every season-scoped page. Injects its own
// styles and markup right below .topbar, and carries season/campus query
// params forward so switching tabs never loses context.
(function () {
  function init() {
    var topbar = document.querySelector(".topbar");
    if (!topbar) return;

    var style = document.createElement("style");
    style.textContent = [
      ".ocr-tabnav {",
      "  background: var(--surface);",
      "  border-bottom: 1px solid var(--border);",
      "  position: sticky;",
      "  z-index: 9;",
      "}",
      ".ocr-tabnav-inner {",
      "  max-width: 1400px;",
      "  margin: 0 auto;",
      "  padding: 0 16px;",
      "  display: flex;",
      "  justify-content: center;",
      "  gap: 4px;",
      "  overflow-x: auto;",
      "  white-space: nowrap;",
      "}",
      ".ocr-tabnav-item {",
      "  font-family: inherit;",
      "  font-size: 13px;",
      "  font-weight: 500;",
      "  color: var(--text-muted);",
      "  text-decoration: none;",
      "  padding: 11px 18px;",
      "  border-bottom: 2px solid transparent;",
      "  flex-shrink: 0;",
      "}",
      ".ocr-tabnav-item:hover {",
      "  color: var(--text);",
      "}",
      ".ocr-tabnav-item.active {",
      "  color: var(--text);",
      "  font-weight: 600;",
      "  border-bottom-color: var(--accent);",
      "}"
    ].join("\n");
    document.head.appendChild(style);

    var currentFile = (window.location.pathname.split("/").pop() || "index.html");
    var params = new URLSearchParams(window.location.search);
    var season = params.get("season");
    var campus = params.get("campus");
    var qs = "";
    if (season && campus) {
      qs = "?season=" + encodeURIComponent(season) + "&campus=" + encodeURIComponent(campus);
    }

    var tabs = [
      { file: "index.html", label: "Tracker" },
      { file: "calendar.html", label: "Calendar" },
      { file: "attendance.html", label: "Attendance" },
      { file: "dashboard.html", label: "Dashboard" }
    ];

    var itemsHtml = tabs.map(function (t) {
      var active = t.file === currentFile;
      return '<a href="' + t.file + qs + '" class="ocr-tabnav-item' + (active ? " active" : "") + '">' + t.label + "</a>";
    }).join("");

    var nav = document.createElement("nav");
    nav.className = "ocr-tabnav";
    nav.setAttribute("aria-label", "Season navigation");
    nav.innerHTML = '<div class="ocr-tabnav-inner">' + itemsHtml + "</div>";

    topbar.insertAdjacentElement("afterend", nav);

    // Keep the tab row pinned directly under the topbar even when the
    // topbar's height changes after this initial measurement — e.g. a
    // season's custom logo image loads asynchronously (after an auth-gated
    // Supabase fetch) and can grow the topbar well after page load. A
    // plain resize listener only catches viewport changes, not this.
    function syncTop() {
      nav.style.top = topbar.offsetHeight + "px";
    }
    syncTop();
    if (window.ResizeObserver) {
      new ResizeObserver(syncTop).observe(topbar);
    } else {
      window.addEventListener("resize", syncTop);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
