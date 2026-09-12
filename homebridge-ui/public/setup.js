import { SetupDraft } from './model.js';
const hb = window.homebridge;
const $ = (id) => document.getElementById(id);
let base,
  blocks,
  draft,
  step = 0,
  limit = 50,
  favoriteLimit = 50,
  busy = false;
const steps = ['account-step', 'library-step', 'favorites-step', 'review-step'];
function message(text) {
  $('notice').textContent = text;
  $('notice').hidden = !text;
}
function setBusy(value) {
  busy = value;
  for (const id of ['discover', 'back', 'next', 'advanced']) {
    $(id).disabled = value;
  }
  $('discover').textContent = value && step === 0 ? 'Discovering…' : 'Discover devices and themes';
  $('setup').setAttribute('aria-busy', String(value));
}
function syncAccent() {
  // Homebridge injects its theme styles asynchronously. Sample an enabled control after they arrive.
  const probe = document.createElement('button');
  probe.className = 'btn btn-primary';
  probe.hidden = true;
  document.body.append(probe);
  const color = window.getComputedStyle(probe).backgroundColor;
  probe.remove();
  if (color !== 'rgba(0, 0, 0, 0)') {
    $('setup').style.setProperty('--setup-accent', color);
  }
}
window.addEventListener('load', syncAccent);
function navigate(next) {
  syncAccent();
  step = next;
  message('');
  steps.forEach((id, index) => {
    $(id).hidden = index !== step;
  });
  document.querySelectorAll('.setup-steps li').forEach((item, index) => {
    if (index === step) {
      item.setAttribute('aria-current', 'step');
    } else {
      item.removeAttribute('aria-current');
    }
  });
  $('navigation').hidden = step === 0;
  $('next').textContent = ['Discover', 'Choose favorites', 'Review setup', 'Save setup'][step];
  if (step === 1) {
    renderLibrary();
  }
  if (step === 2) {
    renderFavorites();
  }
  if (step === 3) {
    renderSummary();
  }
  $('heading').focus();
  hb.fixScrollHeight();
}
function choices() {
  const known = new Set(draft.themes.map((theme) => theme.id));
  return [
    ...draft.themes,
    ...[...draft.selected].filter((id) => !known.has(id)).map((id) => ({ id, name: `Unavailable theme (${id.slice(0, 8)})`, unavailable: true })),
  ];
}
function renderList(target, list, selected, onChange, prefix) {
  const focusId = $(target).contains(document.activeElement) ? document.activeElement.id : undefined;
  const nodes = list.map((theme) => {
    const label = document.createElement('label');
    label.className = 'theme-choice';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.id = `${target}-${theme.id}`;
    check.className = 'form-check-input';
    check.checked = selected.has(theme.id);
    check.disabled = !!theme.unavailable && prefix === 'Favorite' && !check.checked;
    if (check.disabled) {
      label.title = 'This theme cannot be added until it returns to the catalog.';
    }
    check.setAttribute('aria-label', `${prefix} ${theme.name}`);
    check.addEventListener('change', () => {
      try {
        onChange(theme.id, check.checked);
        message('');
      } catch (error) {
        check.checked = !check.checked;
        message(error.message);
      }
    });
    const text = document.createElement('span');
    text.textContent = theme.name;
    // Titles are external data. Use text nodes so markup cannot execute.
    label.append(check, text);
    return label;
  });
  $(target).replaceChildren(...nodes);
  if (focusId) {
    document.getElementById(focusId)?.focus({ preventScroll: true });
  }
  if (!nodes.length) {
    const p = document.createElement('p');
    p.className = 'text-muted';
    p.textContent = 'No matching themes. Try another search or change your library selection.';
    $(target).append(p);
  }
  hb.fixScrollHeight();
}
function renderLibrary() {
  const query = $('search').value.trim().toLocaleLowerCase();
  const matches = choices().filter((theme) => theme.name.toLocaleLowerCase().includes(query));
  $('count').textContent = `${draft.selected.size} selected · ${draft.themes.length} available`;
  $('future').checked = draft.mode === 'all';
  renderList(
    'theme-list',
    matches.slice(0, limit),
    draft.selected,
    (id, checked) => {
      draft.select(id, checked);
      renderLibrary();
    },
    'Include',
  );
  $('more').hidden = matches.length <= limit;
}
function renderFavorites() {
  const lampId = $('lamp').value;
  const favorites = draft.favorites.get(lampId);
  if (!favorites) {
    $('favorite-list').textContent = 'No lamps found. Add a lamp to Wi-Fi in the Moonside app, then discover again.';
    return;
  }
  const enabled = draft.enabled.get(lampId);
  $('device-enabled').checked = enabled;
  $('device-theme-settings').hidden = !enabled;
  if (!enabled) {
    hb.fixScrollHeight();
    return;
  }
  const custom = draft.libraries.get(lampId);
  $('device-library').value = custom ? 'custom' : 'shared';
  $('device-library-list').hidden = !custom;
  $('device-library-hint').hidden = !custom;
  if (custom) {
    renderList(
      'device-library-list',
      choices().filter((theme) => draft.selected.has(theme.id)),
      custom,
      (id, checked) => {
        if (checked) {
          custom.add(id);
        } else {
          custom.delete(id);
          draft.favorites.get(lampId).delete(id);
        }
        renderFavorites();
      },
      'Allow',
    );
  }
  const query = $('favorite-search').value.trim().toLocaleLowerCase();
  const matches = choices().filter(
    (theme) =>
      draft.selected.has(theme.id) && (!custom || custom.has(theme.id)) && theme.name.toLocaleLowerCase().includes(query),
  );
  $('favorite-count').textContent = `${favorites.size} of 99 favorites`;
  renderList(
    'favorite-list',
    matches.slice(0, favoriteLimit),
    favorites,
    (id, checked) => {
      draft.favorite(lampId, id, checked);
      renderFavorites();
    },
    'Favorite',
  );
  $('favorite-more').hidden = matches.length <= favoriteLimit;
}
function renderSummary() {
  const title = document.createElement('p');
  title.className = 'fw-bold';
  title.textContent = `${draft.selected.size} themes selected${draft.mode === 'all' ? ', with new catalog themes included after restart' : ''}.`;
  const list = document.createElement('ul');
  list.className = 'list-group mb-3';
  draft.lamps.forEach((lamp, index) => {
    const row = document.createElement('li');
    row.className = 'list-group-item';
    const ids = draft.enabled.get(lamp.id) ? draft.favorites.get(lamp.id) : new Set();
    const removed = lamp.favorites.ids.filter((id) => !ids.has(id)).length;
    const enabled = draft.enabled.get(lamp.id);
    const librarySize = draft.libraries.get(lamp.id)?.size ?? draft.selected.size;
    const favoriteLabel = ids.size === 1 ? 'favorite' : 'favorites';
    row.textContent = `${lamp.name} · Device ${index + 1}: ${
      enabled ? `${librarySize} ${librarySize === 1 ? 'theme' : 'themes'}, ${ids.size} Apple Home ${favoriteLabel}` : 'Themes disabled'
    }${removed ? ` (${removed} previous favorites removed)` : ''}`;
    list.append(row);
  });
  $('summary').replaceChildren(title, list);
  if (draft.preserved.length) {
    const note = document.createElement('p');
    note.textContent = `Saved choices for ${draft.preserved.length} unavailable ${draft.preserved.length === 1 ? 'device' : 'devices'} will be kept.`;
    $('summary').append(note);
  }
}
$('account-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) {
    return;
  }
  setBusy(true);
  message('');
  hb.hideSchemaForm();
  hb.disableSaveButton();
  try {
    const discovery = await hb.request('/discover', {
      email: $('email').value.trim(),
      password: $('password').value,
      firebaseApiKey: base.firebaseApiKey,
      themeSwitches: base.themeSwitches,
    });
    if (!discovery.lamps.length) {
      throw new Error('No lamps found. Connect a lamp to Wi-Fi in the Moonside app, then try discovery again.');
    }
    if (!discovery.themes.length) {
      throw new Error('The catalog is empty. Your saved choices are unchanged. Try discovery again later.');
    }
    draft = new SetupDraft($('email').value.trim() === (base.email ?? '').trim() ? base : {}, discovery);
    $('lamp').replaceChildren(
      ...draft.lamps.map((lamp, index) => {
        const option = document.createElement('option');
        option.value = lamp.id;
        option.textContent = `${lamp.name}${lamp.model ? ` · ${lamp.model}` : ''} · Device ${index + 1}`;
        return option;
      }),
    );
    navigate(1);
  } catch (error) {
    message(error.message || 'Discovery failed. Please try again.');
  } finally {
    setBusy(false);
  }
});
$('next').addEventListener('click', async () => {
  if (busy) {
    return;
  }
  if (step < 3) {
    navigate(step + 1);
    return;
  }
  setBusy(true);
  message('');
  try {
    const current = await hb.getPluginConfig();
    if (JSON.stringify(current) !== JSON.stringify(blocks)) {
      throw new Error('Plugin settings changed elsewhere. Close and reopen setup before saving.');
    }
    const setup = await hb.request('/prepare', draft.payload());
    const next = {
      ...base,
      platform: 'MoonsideCloud',
      name: base.name || 'Moonside Cloud',
      email: $('email').value.trim(),
      password: $('password').value,
      themePicker: true,
      themeSetup: setup,
    };
    await hb.updatePluginConfig([next, ...blocks.slice(1)]);
    try {
      await hb.savePluginConfig();
    } catch {
      await hb.updatePluginConfig(blocks);
      throw new Error('Save could not be confirmed. Reopen settings to check before retrying.');
    }
    steps.forEach((id) => {
      $(id).hidden = true;
    });
    $('navigation').hidden = true;
    $('finished').hidden = false;
    $('password').value = '';
    hb.fixScrollHeight();
  } catch (error) {
    message(error.message || 'Could not save. Your choices remain here.');
  } finally {
    setBusy(false);
  }
});
$('back').addEventListener('click', () => navigate(step - 1));
$('search').addEventListener('input', () => {
  limit = 50;
  renderLibrary();
});
$('favorite-search').addEventListener('input', () => {
  favoriteLimit = 50;
  renderFavorites();
});
$('device-enabled').addEventListener('change', () => {
  draft.enabled.set($('lamp').value, $('device-enabled').checked);
  renderFavorites();
});
$('device-library').addEventListener('change', () => {
  draft.libraries.set($('lamp').value, $('device-library').value === 'custom' ? new Set(draft.selected) : undefined);
  renderFavorites();
});
$('lamp').addEventListener('change', () => {
  $('favorite-search').value = '';
  favoriteLimit = 50;
  renderFavorites();
});
$('all').addEventListener('click', () => {
  draft.selectAll();
  renderLibrary();
});
$('clear').addEventListener('click', () => {
  draft.clear();
  renderLibrary();
});
$('future').addEventListener('change', () => {
  draft.mode = $('future').checked ? 'all' : 'selected';
  if (draft.mode === 'all') {
    draft.selectAll();
  }
  renderLibrary();
});
$('more').addEventListener('click', () => {
  limit += 50;
  renderLibrary();
});
$('favorite-more').addEventListener('click', () => {
  favoriteLimit += 50;
  renderFavorites();
});
$('favorite-clear').addEventListener('click', () => {
  draft.favorites.get($('lamp').value)?.clear();
  renderFavorites();
});
$('reveal').addEventListener('click', () => {
  const reveal = $('password').type === 'password';
  $('password').type = reveal ? 'text' : 'password';
  $('reveal').setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
  $('reveal').setAttribute('aria-pressed', String(reveal));
});
hb.addEventListener('configChanged', (event) => {
  if (!Array.isArray(event.data)) {
    return;
  }
  blocks = event.data;
  base = blocks[0] ?? {};
  $('email').value = base.email ?? '';
  $('password').value = base.password ?? '';
});
$('advanced').addEventListener('click', () => {
  hb.showSchemaForm();
  hb.enableSaveButton();
});
$('done').addEventListener('click', () => hb.closeSettings());
try {
  setBusy(true);
  $('email').disabled = true;
  $('password').disabled = true;
  $('setup').dataset.mode = await hb.userCurrentLightingMode();
  hb.disableSaveButton();
  blocks = await hb.getPluginConfig();
  base = blocks[0] ?? {};
  $('email').value = base.email ?? '';
  $('password').value = base.password ?? '';
  $('email').disabled = false;
  $('password').disabled = false;
  setBusy(false);
  syncAccent();
} catch {
  message('Could not read plugin settings. Close this window and try again.');
  $('discover').disabled = true;
}
