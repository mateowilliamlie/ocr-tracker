(function () {
  function getPreferredTheme() {
    var stored = localStorage.getItem("ocr-theme");
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  document.documentElement.setAttribute("data-theme", getPreferredTheme());
})();

function toggleOcrTheme() {
  var current = document.documentElement.getAttribute("data-theme") || "light";
  var next = current === "dark" ? "light" : "dark";
  localStorage.setItem("ocr-theme", next);
  document.documentElement.setAttribute("data-theme", next);
  var btn = document.getElementById("theme-toggle-btn");
  if (btn) btn.textContent = next === "dark" ? "☀️" : "🌙";
}

document.addEventListener("DOMContentLoaded", function () {
  var btn = document.getElementById("theme-toggle-btn");
  if (!btn) return;
  var current = document.documentElement.getAttribute("data-theme") || "light";
  btn.textContent = current === "dark" ? "☀️" : "🌙";
  btn.addEventListener("click", toggleOcrTheme);
});
