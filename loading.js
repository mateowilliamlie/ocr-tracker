function showPageLoader() {
  const el = document.getElementById("page-loader");
  if (el) el.classList.remove("hide");
}
function hidePageLoader() {
  const el = document.getElementById("page-loader");
  if (el) el.classList.add("hide");
}
