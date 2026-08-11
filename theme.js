(function () {
  function getPreferredTheme() {
    var stored = localStorage.getItem("ocr-theme");
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  document.documentElement.setAttribute("data-theme", getPreferredTheme());
})();

function applyOcrTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("ocr-theme", theme);
}

document.addEventListener("DOMContentLoaded", function () {
  var checkbox = document.getElementById("theme-toggle-checkbox");
  if (!checkbox) return;
  var current = document.documentElement.getAttribute("data-theme") || "light";
  checkbox.checked = current === "dark";
  checkbox.addEventListener("change", function () {
    applyOcrTheme(checkbox.checked ? "dark" : "light");
  });
});
