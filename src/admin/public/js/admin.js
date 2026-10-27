// Confirmation dialogs: <form data-confirm="Really delete this?"> asks before submitting.
// (Inline onsubmit="" would be blocked by the panel's Content-Security-Policy, so it is done here.)
document.addEventListener("submit", function (e) {
  var message = e.target && e.target.dataset ? e.target.dataset.confirm : "";
  if (message && !window.confirm(message)) e.preventDefault();
});
