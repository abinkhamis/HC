// Interactive guided tour + (?) help tips.
// The tour only highlights and explains what is on the screen. It never saves,
// issues or approves anything: while it runs, a layer blocks clicks on the page,
// and the only actions a step may perform are opening/closing a form or
// switching a tab (no request that changes data is ever sent).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function waitFor(selector, timeout = 2500, root = document) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const el = typeof selector === 'function' ? selector() : root.querySelector(selector);
    if (el && el.getClientRects().length) return el;
    await sleep(80);
  }
  return null;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const topDialog = () => [...document.querySelectorAll('dialog[open]')].pop() || null;

/**
 * steps: [{ title, text (string or (target) => string), target?: () => Element|null|Promise, before?: async () => void, missing?: string }]
 * A step whose target is missing is shown centred with its `missing` text (never claims a button exists).
 */
export function startTour({ steps, title = 'جولة تعريفية', onEnd }) {
  let i = 0;
  let current = null;
  let layer = null;
  let ended = false;
  let seq = 0;

  const build = (host) => {
    layer?.remove();
    layer = document.createElement('div');
    layer.className = 'tour-layer';
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-modal', 'true');
    layer.setAttribute('aria-label', title);
    layer.innerHTML = '<div class="tour-block"></div><div class="tour-spot" hidden></div><div class="tour-pop" tabindex="-1"></div>';
    host.appendChild(layer);
    layer.querySelector('.tour-block').addEventListener('click', (e) => e.stopPropagation());
    return layer;
  };

  const place = () => {
    if (!layer) return;
    const spot = layer.querySelector('.tour-spot');
    const pop = layer.querySelector('.tour-pop');
    const narrow = window.innerWidth < 640;
    pop.classList.toggle('sheet', narrow);
    pop.classList.remove('at-top');
    if (!current) {
      spot.hidden = true;
      pop.style.cssText = narrow ? '' : `top:${Math.max(16, (window.innerHeight - pop.offsetHeight) / 2)}px;left:${Math.max(16, (window.innerWidth - pop.offsetWidth) / 2)}px`;
      return;
    }
    const r = current.getBoundingClientRect();
    const pad = 6;
    spot.hidden = false;
    spot.style.cssText = `top:${r.top - pad}px;left:${r.left - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px`;
    if (narrow) {
      pop.style.cssText = '';
      // the bottom sheet moves to the top when it would cover the highlighted element
      const h = pop.offsetHeight;
      pop.classList.toggle('at-top', r.bottom > window.innerHeight - h - 16 && r.top > h + 16);
      return;
    }
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    let top = r.bottom + 14;
    if (top + h > window.innerHeight - 12) top = Math.max(12, r.top - h - 14);
    let left = r.left + r.width / 2 - w / 2;
    left = Math.min(Math.max(12, left), window.innerWidth - w - 12);
    pop.style.cssText = `top:${top}px;left:${left}px`;
  };

  async function show(n) {
    i = Math.max(0, Math.min(n, steps.length - 1));
    const my = ++seq; // a newer step request wins over a slower older one
    const s = steps[i];
    if (s.before) { try { await s.before(); } catch { /* a missing screen element is reported below */ } }
    let target = null;
    if (s.target) { try { target = await s.target(); } catch { target = null; } }
    if (ended) { onEnd?.(); return; } // skipped while a step was preparing: tidy up what it opened
    if (my !== seq) return;
    current = target;
    build(target?.closest('dialog[open]') || topDialog() || document.body);
    if (target) {
      // a tall target (e.g. a group of fields on a phone) is scrolled so its start is visible
      const tall = target.getBoundingClientRect().height > window.innerHeight * 0.45;
      target.scrollIntoView({ block: tall ? 'start' : 'center', inline: 'nearest', behavior: 'instant' });
    }
    const last = i === steps.length - 1;
    const pop = layer.querySelector('.tour-pop');
    pop.innerHTML = `
      <div class="tour-head"><span class="tour-count">${i + 1} / ${steps.length}</span><button type="button" class="tour-x" data-t="skip" aria-label="تخطي الجولة">×</button></div>
      <h3>${esc(s.title)}</h3>
      <p>${esc(typeof s.text === 'function' ? s.text(target) : s.text)}</p>
      ${!target && s.target && s.missing ? `<p class="tour-note">${esc(s.missing)}</p>` : ''}
      <div class="tour-dots" aria-hidden="true">${steps.map((_, k) => `<span class="${k === i ? 'on' : ''}"></span>`).join('')}</div>
      <div class="tour-actions">
        <button type="button" class="btn small" data-t="prev" ${i === 0 ? 'disabled' : ''}>السابق</button>
        <button type="button" class="btn small primary" data-t="${last ? 'end' : 'next'}">${last ? 'إنهاء' : 'التالي'}</button>
        ${last ? '' : '<button type="button" class="btn small tour-skip" data-t="skip">تخطي</button>'}
      </div>`;
    pop.querySelectorAll('[data-t]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const a = b.dataset.t;
      if (a === 'next') show(i + 1);
      else if (a === 'prev') show(i - 1);
      else end();
    }));
    place();
    pop.focus({ preventScroll: true });
    requestAnimationFrame(place); // re-measure once the popover has its final size
  }

  const onKey = (e) => {
    if (!layer) return;
    const inPop = layer.querySelector('.tour-pop')?.contains(e.target);
    // nothing behind the tour can be activated from the keyboard either
    if (!inPop && (e.key === 'Enter' || e.key === ' ' || e.key === 'Tab')) { e.preventDefault(); e.stopPropagation(); layer.querySelector('.tour-pop')?.focus(); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(); }
    else if (e.key === 'ArrowLeft') show(i + 1); // RTL: left = forward
    else if (e.key === 'ArrowRight') show(i - 1);
  };
  const onMove = () => place();

  function end() {
    if (ended) return;
    ended = true;
    layer?.remove();
    layer = null;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onMove);
    window.removeEventListener('scroll', onMove, true);
    onEnd?.();
  }

  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onMove);
  window.addEventListener('scroll', onMove, true);
  show(0);
  return { end };
}

// ---------- (?) help tips ----------
// helpTip('text') → a small button; clicking it shows a short Arabic explanation.
export const helpTip = (text, topic = '') =>
  `<button type="button" class="help-tip" data-help="${esc(text)}" aria-label="شرح${topic ? `: ${esc(topic)}` : ''}" aria-expanded="false">?</button>`;

let bubble = null;
let owner = null;
function closeTip() {
  bubble?.remove();
  owner?.setAttribute('aria-expanded', 'false');
  bubble = null;
  owner = null;
}
export function installHelpTips() {
  if (window.__helpTipsInstalled) return;
  window.__helpTipsInstalled = true;
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('.help-tip');
    if (!b) { if (bubble && !e.target.closest?.('.help-bubble')) closeTip(); return; }
    e.preventDefault();
    e.stopPropagation();
    if (owner === b) { closeTip(); return; }
    closeTip();
    owner = b;
    b.setAttribute('aria-expanded', 'true');
    bubble = document.createElement('div');
    bubble.className = 'help-bubble';
    bubble.setAttribute('role', 'note');
    bubble.textContent = b.dataset.help;
    (b.closest('dialog[open]') || document.body).appendChild(bubble);
    const r = b.getBoundingClientRect();
    const narrow = window.innerWidth < 640;
    const w = Math.min(300, window.innerWidth - 24);
    bubble.style.width = `${w}px`;
    let top = r.bottom + 8;
    if (top + bubble.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - bubble.offsetHeight - 8);
    const left = narrow ? 12 : Math.min(Math.max(12, r.left + r.width / 2 - w / 2), window.innerWidth - w - 12);
    bubble.style.top = `${top}px`;
    bubble.style.left = `${left}px`;
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && bubble) { e.stopPropagation(); closeTip(); } }, true);
  window.addEventListener('scroll', () => bubble && closeTip(), true);
  window.addEventListener('resize', () => bubble && closeTip());
}
