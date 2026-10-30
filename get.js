// Get KOIN and VHP: copy buttons for the token addresses.
for (const b of document.querySelectorAll("[data-copy]")) b.addEventListener("click", async () => {
  const t = document.getElementById(b.dataset.copy).textContent.trim();
  try { await navigator.clipboard.writeText(t); b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1500); } catch { b.textContent = "Select it"; }
});
