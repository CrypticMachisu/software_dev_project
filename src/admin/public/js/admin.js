// Confirmation dialogs: <form data-confirm="Really delete this?"> asks before submitting.
// (Inline onsubmit="" would be blocked by the panel's Content-Security-Policy, so it is done here.)
document.addEventListener("submit", function (e) {
  var message = e.target && e.target.dataset ? e.target.dataset.confirm : "";
  if (message && !window.confirm(message)) e.preventDefault();
});

// Report printing: <button data-print> opens the browser's print / save-as-PDF dialog.
// The print stylesheet drops the sidebar, the filter bar and the log-out header.
document.addEventListener("click", function (e) {
  var trigger = e.target && e.target.closest ? e.target.closest("[data-print]") : null;
  if (trigger) window.print();
});

// Product image URL preview: input[type=url] + img[data-image-preview], wrapped in [data-image-preview-wrap].
document.addEventListener("DOMContentLoaded", function () {
  var input = document.querySelector('[name="imageUrl"]');
  var preview = document.querySelector("img[data-image-preview]");
  if (!input || !preview) return;
  var wrap = preview.closest("[data-image-preview-wrap]");
  var empty = wrap ? wrap.querySelector("[data-image-preview-empty]") : null;

  function render() {
    var value = input.value.trim();
    if (!/^https?:\/\//i.test(value)) {
      preview.removeAttribute("src");
      if (wrap) wrap.hidden = true;
      if (empty) empty.hidden = false;
      return;
    }
    preview.src = value;
    if (wrap) wrap.hidden = false;
    if (empty) empty.hidden = true;
  }

  input.addEventListener("input", render);
  preview.addEventListener("error", function () {
    preview.removeAttribute("src");
    if (wrap) wrap.hidden = true;
    if (empty) empty.hidden = false;
  });
  render();
});
