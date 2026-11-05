/**
 * Side browser.
 *
 * The classification scheme used to be a screen of its own: you either saw
 * the tree or you saw the documents. The browser puts it next to the results,
 * which is how an archive is actually used: you walk a branch and look at
 * what is inside without losing sight of where you are.
 *
 * Three ways through the same material:
 *   - Folders      - the real structure on disk, the one the user knows.
 *   - Record types - baptisms, marriages and burials, by century.
 *   - Tags         - the user's own marks, not a classification but a way of
 *                    working.
 */

const CENTURIES = {
  1500: '16th century',
  1600: '17th century',
  1700: '18th century',
  1800: '19th century',
  1900: '20th century',
  2000: '21st century',
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

const formatNumber = (n) => new Intl.NumberFormat().format(n ?? 0);

/** Expanded branches, so they do not collapse on repaint. */
const expanded = new Set();

/* ---------- Folder tree ---------- */

export function renderFolders(nodes, selection) {
  const children = new Map();
  for (const n of nodes) {
    const k = n.parent_id ?? 0;
    if (!children.has(k)) children.set(k, []);
    children.get(k).push(n);
  }

  const branch = (parent, level) => {
    const list = children.get(parent) ?? [];
    if (list.length === 0) return '';

    return list
      .map((n) => {
        const hasChildren = (children.get(n.id) ?? []).length > 0;
        const open = expanded.has(`c${n.id}`) || level === 0;
        const active = selection?.type === 'unit' && selection.id === n.id;

        return `
          <div>
            <button class="node-exp ${active ? 'active' : ''} ${open ? 'open' : ''}"
                    data-unit-exp="${n.id}" data-key="c${n.id}"
                    data-title="${esc(n.title)}"
                    title="${esc(n.title)} - ${formatNumber(n.documents)} documents">
              <span class="arrow ${hasChildren ? '' : 'hollow'}">▶</span>
              <span class="lbl">${esc(n.title)}</span>
              <span class="count">${formatNumber(n.documents)}</span>
            </button>
            ${
              hasChildren
                ? `<div class="br-branch" data-branch="c${n.id}" ${open ? '' : 'hidden'}>
                     ${branch(n.id, level + 1)}
                   </div>`
                : ''
            }
          </div>`;
      })
      .join('');
  };

  const html = branch(0, 0);
  return html || '<p class="br-empty">No folders indexed yet.</p>';
}

/* ---------- Tree by record type and century ---------- */

const RECORD_TYPE_NAMES = {
  birth: 'Births',
  baptism: 'Baptisms',
  marriage: 'Marriages',
  burial: 'Burials',
  marriage_licence: 'Marriage licences',
  confirmation: 'Confirmations',
  nuptial_blessing: 'Nuptial blessings',
  index: 'Indexes',
  record: 'Records',
  unknown: 'Unclassified',
};

export function renderRecordTypes(types, selection) {
  if (!types.length) return '<p class="br-empty">No record types recognised yet.</p>';

  return types
    .map((t) => {
      const key = `a${t.type}`;
      const open = expanded.has(key);
      const active = selection?.type === 'record' && selection.id === t.type && !selection.century;

      // Centuries run oldest to most recent; the unreadable years go last,
      // grouped apart so they do not clutter the chronology.
      const withCentury = t.centuries.filter((c) => c.century !== null).sort((a, b) => a.century - b.century);
      const withoutCentury = t.centuries.find((c) => c.century === null);

      const branches = [
        ...withCentury.map((c) => {
          const act =
            selection?.type === 'record' && selection.id === t.type && selection.century === c.century;
          return `
            <button class="node-exp ${act ? 'active' : ''}"
                    data-record-exp="${esc(t.type)}" data-century="${c.century}"
                    data-title="${esc(RECORD_TYPE_NAMES[t.type] ?? t.type)} - ${esc(CENTURIES[c.century] ?? c.century)}">
              <span class="arrow hollow">▶</span>
              <span class="lbl">${esc(CENTURIES[c.century] ?? c.century)}</span>
              <span class="count">${formatNumber(c.n)}</span>
            </button>`;
        }),
        withoutCentury
          ? `<button class="node-exp" data-record-exp="${esc(t.type)}"
                     data-title="${esc(RECORD_TYPE_NAMES[t.type] ?? t.type)} with no date">
               <span class="arrow hollow">▶</span>
               <span class="lbl" style="font-style:italic">no readable date</span>
               <span class="count">${formatNumber(withoutCentury.n)}</span>
             </button>`
          : '',
      ].join('');

      return `
        <div>
          <button class="node-exp ${active ? 'active' : ''} ${open ? 'open' : ''}"
                  data-record-exp="${esc(t.type)}" data-key="${key}"
                  data-title="${esc(RECORD_TYPE_NAMES[t.type] ?? t.type)}"
                  title="${esc(RECORD_TYPE_NAMES[t.type] ?? t.type)} - ${formatNumber(t.total)} documents">
            <span class="arrow">▶</span>
            <span class="lbl">${esc(RECORD_TYPE_NAMES[t.type] ?? t.type)}</span>
            <span class="count">${formatNumber(t.total)}</span>
          </button>
          <div class="br-branch" data-branch="${key}" ${open ? '' : 'hidden'}>${branches}</div>
        </div>`;
    })
    .join('');
}

/* ---------- Tags ---------- */

export function renderTags(tags, selection) {
  const list = tags.length
    ? tags
        .map((t) => {
          const active = selection?.type === 'tag' && selection.id === t.id;
          return `
            <div class="tag-row">
              <button class="node-exp ${active ? 'active' : ''}"
                      data-tag-exp="${t.id}" data-title="${esc(t.name)}"
                      title="${esc(t.name)}">
                <span class="tag-dot" ${t.color ? `style="background:${esc(t.color)}"` : ''}></span>
                <span class="lbl">${esc(t.name)}</span>
                <span class="count">${formatNumber(t.documents)}</span>
              </button>
              <button class="remove-tag" data-remove-tag="${t.id}"
                      data-name="${esc(t.name)}" data-count="${t.documents}"
                      title="Delete the tag &quot;${esc(t.name)}&quot;"
                      aria-label="Delete the tag ${esc(t.name)}">✕</button>
            </div>`;
        })
        .join('')
    : `<p class="br-empty">
         No tags yet. They are for marking what you are working through:
         "reviewed", "request a copy at the archive", "maternal line"…
       </p>`;

  return `
    <form class="br-new" id="form-tag">
      <input id="new-tag" placeholder="New tag…" maxlength="60" autocomplete="off">
      <button type="submit">+</button>
    </form>
    ${list}`;
}

/** Opens or closes a branch of the tree. */
export function toggleBranch(key) {
  const branch = document.querySelector(`[data-branch="${CSS.escape(key)}"]`);
  const button = document.querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (!branch) return false;

  const open = branch.hidden;
  branch.hidden = !open;
  button?.classList.toggle('open', open);
  if (open) expanded.add(key);
  else expanded.delete(key);
  return true;
}
