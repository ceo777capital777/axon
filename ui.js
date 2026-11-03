/* AXON — анимации интерфейса: появление, расшифровка заголовков, фильтр кейсов, курсор */
(function () {
  'use strict';
  const root = document.documentElement;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));

  /* ---------- «Расшифровка» текста ---------- */
  const GLYPHS = '01<>/\\|_-=+*#[]{}АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЭЮЯABCDEFGHKMNPRSTXZ';
  function scramble(el, delay) {
    const final = el.textContent;
    if (reduce) return;
    const len = final.length;
    el.setAttribute('aria-label', final);
    el.textContent = final.replace(/\S/g, ' ');
    const dur = Math.min(900, 280 + len * 35);
    let start = 0;
    function tick(t) {
      if (!start) start = t;
      const p = Math.min(1, (t - start) / dur);
      let out = '';
      for (let i = 0; i < len; i++) {
        const ch = final[i];
        const reveal = i / len;
        if (ch === ' ' || p >= 1 || p > reveal + 0.25) out += ch;
        else if (p > reveal - 0.1) out += GLYPHS[(Math.random() * GLYPHS.length) | 0];
        else out += ' ';
      }
      el.textContent = out;
      if (p < 1) requestAnimationFrame(tick); else { el.textContent = final; el.removeAttribute('aria-label'); }
    }
    setTimeout(() => requestAnimationFrame(tick), delay);
  }

  /* ---------- Появление ---------- */
  $$('.chip').forEach((c, i) => c.style.setProperty('--i', i));
  $$('.card').forEach((c, i) => c.style.setProperty('--i', i));
  function start() {
    root.classList.add('is-ready');
    $$('[data-scramble]').forEach((el) => {
      const host = el.closest('[data-reveal]');
      const i = host ? +getComputedStyle(host).getPropertyValue('--i') || 0 : 0;
      scramble(el, i * 120 + 250);
    });
    setTimeout(() => {
      root.classList.add('is-settled');
      window.dispatchEvent(new Event('axon:layout'));
    }, reduce ? 0 : 1900);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(start));
  else requestAnimationFrame(start);

  /* ---------- Счётчик ---------- */
  const counter = $('.counter'), num = $('.counter__num');
  function setCount(n) {
    const txt = String(n).padStart(2, '0');
    if (!num || num.textContent === txt) return;
    num.textContent = txt;
    counter.setAttribute('aria-label', 'Кейсов показано: ' + n);
    counter.classList.remove('is-pulse'); void counter.offsetWidth; counter.classList.add('is-pulse');
  }

  /* ---------- Фильтр кейсов по чипам ---------- */
  const chips = $$('.chip'), cards = $$('.card'), list = $('.list');
  let filterTimer = 0;
  chips.forEach((chip) => chip.addEventListener('click', () => {
    const f = chip.dataset.filter;
    chips.forEach((c) => { const on = c === chip; c.classList.toggle('is-active', on); c.setAttribute('aria-pressed', on); });
    const match = (card) => f === 'all' || card.dataset.tags.split(',').includes(f);
    const OUT = reduce ? 0 : 320;
    // 1) уводим лишние
    cards.forEach((card) => { if (!match(card) && !card.classList.contains('is-hidden')) card.classList.add('is-out'); });
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      let j = 0;
      cards.forEach((card) => {
        if (match(card)) {
          const wasHidden = card.classList.contains('is-hidden');
          card.classList.remove('is-hidden');
          if (wasHidden || card.classList.contains('is-out')) {
            card.classList.add('is-out');
            card.style.setProperty('--j', j);
            void card.offsetWidth;
            card.classList.remove('is-out');
          }
          j++;
        } else {
          card.classList.add('is-hidden', 'is-out');
        }
      });
      if (list) list.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
      setCount(j);
    }, OUT);
  }));

  /* ---------- Видео: играть только когда видно ---------- */
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => entries.forEach((e) => {
      const v = e.target;
      if (e.isIntersecting) { const p = v.play(); if (p && p.catch) p.catch(() => {}); } else v.pause();
    }), { root: list, threshold: 0.05 });
    $$('.card video').forEach((v) => io.observe(v));
  }

  /* ---------- Курсор-точка ---------- */
  const dot = $('.cursor');
  if (dot && finePointer) {
    let x = innerWidth / 2, y = innerHeight / 2, tx = x, ty = y, raf = 0, shown = false;
    const k = reduce ? 1 : 0.22;
    function loop() {
      x += (tx - x) * k; y += (ty - y) * k;
      dot.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0)';
      raf = (Math.abs(tx - x) + Math.abs(ty - y) > 0.1) ? requestAnimationFrame(loop) : 0;
    }
    window.addEventListener('mousemove', (e) => {
      tx = e.clientX; ty = e.clientY;
      if (!shown) { shown = true; x = tx; y = ty; root.classList.add('has-cursor'); }
      if (!raf) raf = requestAnimationFrame(loop);
      const hit = e.target.closest && e.target.closest('a, button, .card');
      dot.classList.toggle('is-hover', !!hit);
    }, { passive: true });
    document.addEventListener('mouseleave', () => { dot.style.opacity = '0'; });
    document.addEventListener('mouseenter', () => { dot.style.opacity = ''; });
    window.addEventListener('mousedown', () => dot.classList.add('is-down'));
    window.addEventListener('mouseup', () => dot.classList.remove('is-down'));
  }
})();
