(() => {
  try {
    const saved = localStorage.getItem('qgz-share-theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme =
      saved === 'light' || saved === 'dark' ? saved : prefersDark ? 'dark' : 'light';
  } catch {
    document.documentElement.dataset.theme = 'light';
  }
})();
