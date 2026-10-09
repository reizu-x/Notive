// Boot gate: hides the static shell markup until the app module hydrates it.
// The class is removed by js/app.js as soon as its module graph finishes
// loading; the fallback timer guarantees the page can never stay blank if the
// module fails (fail-open back to the static shell instead of an infinite
// white screen).
document.documentElement.classList.add('app-boot');
setTimeout(() => { document.documentElement.classList.remove('app-boot'); }, 4000);
