/** UI draft only. Nothing is persisted until the review step is saved. */
export class SetupDraft {
  constructor(config, discovery) {
    this.themes = discovery.themes;
    this.lamps = discovery.lamps;
    const setup = config.themeSetup;
    this.preserved = (setup?.lamps ?? [])
      .filter((plan) => !this.lamps.some((lamp) => lamp.id === plan.deviceId))
      .map((plan) => ({ ...plan, selectedIds: plan.selectedIds ?? [...(setup?.selectedIds ?? [])] }));
    this.mode = setup?.mode ?? 'selected';
    const existingNames = new Set((config.themeSwitches ?? []).map((name) => name.trim().replace(/\s+/g, ' ').toLowerCase()));
    this.selected = new Set(
      setup?.selectedIds ??
        discovery.configuredIds ??
        this.themes.filter((theme) => existingNames.has(theme.name.toLowerCase())).map((theme) => theme.id),
    );
    this.enabled = new Map(
      this.lamps.map((lamp) => {
        const plan = setup?.lamps.find((item) => item.deviceId === lamp.id);
        return [lamp.id, plan ? plan.enabled !== false : lamp.favorites.ids.length > 0];
      }),
    );
    this.libraries = new Map(
      this.lamps.map((lamp) => {
        const plan = setup?.lamps.find((item) => item.deviceId === lamp.id);
        return [lamp.id, plan?.selectedIds ? new Set(plan.selectedIds) : undefined];
      }),
    );
    this.favorites = new Map(
      this.lamps.map((lamp) => {
        const plan = setup?.lamps.find((item) => item.deviceId === lamp.id);
        const pending = plan && lamp.favorites.setupId !== setup.id && lamp.favorites.revision === plan.expectedRevision;
        return [lamp.id, new Set(pending ? plan.ids : lamp.favorites.ids)];
      }),
    );
    for (const favorites of this.favorites.values()) {
      for (const id of favorites) {
        this.selected.add(id);
      }
    }
    if (this.mode === 'all') {
      this.selectAll();
    }
  }
  selectAll() {
    this.themes.forEach((theme) => this.selected.add(theme.id));
  }
  select(id, enabled) {
    this.mode = 'selected';
    if (enabled) {
      this.selected.add(id);
    } else {
      this.selected.delete(id);
      this.favorites.forEach((favorites) => favorites.delete(id));
      this.libraries.forEach((library) => library?.delete(id));
    }
  }
  clear() {
    this.mode = 'selected';
    this.selected.clear();
    this.libraries.forEach((library) => library?.clear());
    this.favorites.forEach((favorites) => favorites.clear());
  }
  favorite(lampId, id, enabled) {
    const favorites = this.favorites.get(lampId);
    if (
      !favorites ||
      (enabled &&
        (!this.selected.has(id) ||
          !this.enabled.get(lampId) ||
          (this.libraries.get(lampId) && !this.libraries.get(lampId).has(id))))
    ) {
      throw new Error('Select this theme for your library first.');
    }
    if (enabled && !favorites.has(id) && !this.themes.some(theme => theme.id === id)) {
      throw new Error('This theme is unavailable. Existing favorites are kept until it returns.');
    }
    if (enabled && !favorites.has(id) && favorites.size >= 99) {
      throw new Error('Apple Home supports up to 99 theme favorites per lamp.');
    }
    if (enabled) {
      favorites.add(id);
    } else {
      favorites.delete(id);
    }
  }
  payload() {
    return {
      version: 1,
      mode: this.mode,
      selectedIds: [...this.selected],
      lamps: [
        ...this.lamps.map((lamp) => ({
          deviceId: lamp.id,
          ids: this.enabled.get(lamp.id) ? [...this.favorites.get(lamp.id)] : [],
          expectedRevision: lamp.favorites.revision,
          enabled: this.enabled.get(lamp.id),
          ...(this.libraries.get(lamp.id)
            ? { selectedIds: [...this.libraries.get(lamp.id)].filter((id) => this.selected.has(id)) }
            : {}),
        })),
        ...this.preserved,
      ],
    };
  }
}
