(() => {
  const root = document.documentElement;
  const article = document.querySelector('#article');
  const progress = document.querySelector('#reading-progress');

  function setupTheme() {
    const button = document.querySelector('[data-theme-toggle]');
    if (!button) return;

    const sync = () => {
      const dark = root.dataset.theme === 'dark';
      button.setAttribute('aria-label', dark ? '切换到浅色' : '切换到深色');
      button.setAttribute('title', dark ? '切换到浅色' : '切换到深色');
    };

    button.addEventListener('click', () => {
      root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem('share-site-theme', root.dataset.theme);
      } catch {
        // ignore storage errors
      }
      sync();
    });

    sync();
  }

  function setupMath() {
    if (!article || typeof window.renderMathInElement !== 'function') return;

    try {
      window.renderMathInElement(article, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '\\(', right: '\\)', display: false },
        ],
        throwOnError: false,
        strict: false,
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'option'],
      });
    } catch {
      // keep the original text if KaTeX fails
    }
  }

  function slugify(text, index) {
    const base = String(text || '')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .replace(/\s+/g, '-')
      .replace(/^-+|-+$/g, '');
    return base || `section-${index + 1}`;
  }

  function setupHeadingsAndToc() {
    if (!article) return;

    const headings = [...article.querySelectorAll('h1, h2, h3')];
    const used = new Map();

    headings.forEach((heading, index) => {
      let id = heading.id || slugify(heading.textContent, index);
      if (used.has(id)) {
        const count = used.get(id) + 1;
        used.set(id, count);
        id = `${id}-${count}`;
      } else {
        used.set(id, 0);
      }
      heading.id = id;
    });

    const panel = document.querySelector('#toc-panel');
    const nav = document.querySelector('#toc');
    if (!panel || !nav) return;

    if (headings.length < 2) {
      panel.classList.add('is-empty');
      return;
    }

    nav.innerHTML = headings
      .map((heading) => {
        const level = Number(heading.tagName.slice(1));
        return `<a class="toc-link" data-level="${level}" href="#${encodeURIComponent(heading.id)}">${heading.textContent}</a>`;
      })
      .join('');

    const links = [...nav.querySelectorAll('.toc-link')];
    links.forEach((link, index) => {
      link.addEventListener('click', () => {
        document.body.classList.remove('toc-open');
      });
      link.dataset.target = headings[index].id;
      // 目录项不换行、超长省略，悬停时用 title 看全文
      link.title = headings[index].textContent.trim();
    });

    let frame = 0;
    let lastActive = -1;
    const updateActive = () => {
      frame = 0;
      const offset = 120;
      let active = 0;
      headings.forEach((heading, index) => {
        if (heading.getBoundingClientRect().top <= offset) active = index;
      });
      links.forEach((link, index) => {
        link.classList.toggle('is-active', index === active);
      });

      // 选中项跟着正文滚动，别让它在目录里跑出可视范围
      if (active !== lastActive) {
        lastActive = active;
        const link = links[active];
        if (link) {
          const top = link.offsetTop;
          const bottom = top + link.offsetHeight;
          if (top < panel.scrollTop || bottom > panel.scrollTop + panel.clientHeight) {
            panel.scrollTop = Math.max(0, top - panel.clientHeight / 3);
          }
        }
      }
    };

    window.addEventListener(
      'scroll',
      () => {
        if (!frame) frame = requestAnimationFrame(updateActive);
      },
      { passive: true }
    );
    updateActive();

    if (location.hash) {
      const target = decodeURIComponent(location.hash.slice(1));
      const heading = document.getElementById(target);
      if (heading) {
        requestAnimationFrame(() => heading.scrollIntoView({ block: 'start' }));
      }
    }
  }

  function setupTables() {
    if (!article) return;

    article.querySelectorAll('table').forEach((table) => {
      if (table.parentElement?.classList.contains('table-wrap')) return;
      const wrapper = document.createElement('div');
      wrapper.className = 'table-wrap';
      table.parentNode.insertBefore(wrapper, table);
      wrapper.appendChild(table);
    });
  }

  function setupCodeCopy() {
    if (!article) return;

    article.querySelectorAll('pre').forEach((pre) => {
      const code = pre.querySelector('code');
      if (!code) return;

      pre.classList.add('has-copy');
      const language = [...code.classList]
        .find((name) => name.startsWith('language-'))
        ?.replace('language-', '');

      if (language) {
        const label = document.createElement('span');
        label.className = 'code-language';
        label.textContent = language;
        pre.appendChild(label);
      }

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'code-copy';
      button.textContent = '复制';
      button.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(code.innerText);
          button.textContent = '已复制';
          setTimeout(() => {
            button.textContent = '复制';
          }, 1600);
        } catch {
          button.textContent = '复制失败';
          setTimeout(() => {
            button.textContent = '复制';
          }, 1600);
        }
      });
      pre.appendChild(button);
    });
  }

  function setupLightbox() {
    const images = [...document.querySelectorAll('.markdown-body img, .media-view img')];
    if (!images.length) return;

    const overlay = document.createElement('div');
    overlay.className = 'lightbox';
    overlay.innerHTML = '<button type="button" class="lightbox-close" aria-label="关闭">×</button><img alt="">';
    const image = overlay.querySelector('img');
    const close = () => {
      overlay.classList.remove('is-open');
      document.body.classList.remove('lightbox-open');
    };

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay || event.target.closest('.lightbox-close')) close();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close();
    });

    images.forEach((item) => {
      item.classList.add('zoomable');
      item.addEventListener('click', () => {
        image.src = item.currentSrc || item.src;
        image.alt = item.alt || '';
        overlay.classList.add('is-open');
        document.body.classList.add('lightbox-open');
      });
    });

    document.body.appendChild(overlay);
  }

  function setupFilter() {
    const input = document.querySelector('#entry-filter');
    const list = document.querySelector('#entry-list');
    if (!input || !list) return;

    const rows = [...list.querySelectorAll('.entry[data-name]')];
    const empty = document.querySelector('#filter-empty');

    const apply = () => {
      const query = input.value.trim().toLowerCase();
      let visible = 0;
      rows.forEach((row) => {
        const match = !query || row.dataset.name.includes(query);
        row.hidden = !match;
        if (match) visible += 1;
      });
      if (empty) empty.hidden = visible > 0 || !query;
    };

    input.addEventListener('input', apply);
    document.addEventListener('keydown', (event) => {
      if (event.key !== '/') return;
      const target = event.target;
      if (target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      event.preventDefault();
      input.focus();
    });
  }

  function setupTocDrawer() {
    const button = document.querySelector('[data-toc-toggle]');
    const panel = document.querySelector('#toc-panel');
    if (!button || !panel) return;

    const backdrop = document.querySelector('[data-toc-backdrop]');
    const closeButton = document.querySelector('[data-toc-close]');
    const wide = window.matchMedia('(min-width: 1081px)');

    const setOpen = (open) => {
      document.body.classList.toggle('toc-open', open);
      button.setAttribute('aria-expanded', String(open));
    };

    button.addEventListener('click', () => {
      setOpen(!document.body.classList.contains('toc-open'));
    });

    if (closeButton) closeButton.addEventListener('click', () => setOpen(false));
    if (backdrop) backdrop.addEventListener('click', () => setOpen(false));

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') setOpen(false);
    });

    // 点击目录项后收起抽屉（移动端）
    panel.addEventListener('click', (event) => {
      if (event.target.closest('.toc-link')) setOpen(false);
    });

    // 拉宽到桌面尺寸时把抽屉状态清掉，避免残留 body 上的滚动锁
    wide.addEventListener('change', (event) => {
      if (event.matches) setOpen(false);
    });
  }

  function setupProgress() {
    if (!article || !progress) return;

    let frame = 0;
    const update = () => {
      frame = 0;
      const rect = article.getBoundingClientRect();
      const start = rect.top + window.scrollY;
      const height = Math.max(1, rect.height - window.innerHeight + 160);
      const ratio = Math.min(1, Math.max(0, (window.scrollY - start + 80) / height));
      progress.style.transform = `scaleX(${ratio})`;
    };

    window.addEventListener(
      'scroll',
      () => {
        if (!frame) frame = requestAnimationFrame(update);
      },
      { passive: true }
    );
    window.addEventListener('resize', update);
    update();
  }

  setupTheme();
  setupMath();
  setupHeadingsAndToc();
  setupTables();
  setupCodeCopy();
  setupLightbox();
  setupFilter();
  setupTocDrawer();
  setupProgress();
})();
