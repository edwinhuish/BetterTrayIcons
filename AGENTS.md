# AGENTS.md

Guidance for coding agents (and humans) working in this repository: what the
project is, how the code is organised, which module owns what, and the rules a
change has to follow. Read this before editing; it saves rewrites.

Superseded details live in the other docs: user-facing description in
[README.md](README.md), contribution process in [CONTRIBUTING.md](CONTRIBUTING.md),
release history in [CHANGELOG.md](CHANGELOG.md), dev setup on the
[Installation wiki page](https://github.com/nexaknight/BetterTrayIcons/wiki/Installation).

## 1. Project at a glance

**Better Tray Icons** is a GNOME Shell extension that puts StatusNotifierItem
(system) tray icons back into the top panel. Icons that do not fit stay in an
overflow popup behind a toggle button. Every icon can be renamed, hidden,
replaced, reordered, folded into the popup, given state icons and unread badges
on a per-app basis. Settings can be exported, imported and synced across
machines through a shared JSON file.

| Fact | Value |
| --- | --- |
| UUID | `BetterTrayIcons@nexaknight.com` (`metadata.json`) |
| GNOME Shell | 49, 50 (`metadata.json` → `shell-version`) |
| Session | Wayland only, X11 is not supported |
| Languages | GJS / JavaScript (ESM), no build step, no runtime dependencies |
| UI toolkit | Clutter/St inside the shell, GTK4/Adwaita in the preferences window |
| i18n | gettext, domain `bettertrayicons`, `po/*.po` |
| License | GPL-3.0-or-later |
| Conflicts | `appindicatorsupport@rgcjonas.gmail.com`, `ubuntu-appindicators@ubuntu.com`, `trayIconsReloaded@selfmade.pl` (declared in `metadata.json`) |

## 2. Commands

```sh
npm test                  # schema check + translation check + ESLint (what CI runs)
npm run lint              # ESLint only (eslint-config-gnome)
npm run compile-schemas   # glib-compile-schemas schemas/
npm run compile-locales   # po/*.po -> locale/<lang>/LC_MESSAGES/*.mo

make install              # pack + install into ~/.local/share/gnome-shell/extensions
make pack                 # build the extensions.gnome.org zip (no install)
make test                 # npm ci && npm test
make clean / uninstall
```

`gnome-extensions pack` bundles `src/`, `interfaces/`, `assets/`, the schema and
the translations; `media/` stays out. There is no transpilation: the shell and
the prefs window load these files as-is, so ES module syntax and GJS imports
(`gi://`, `resource:///`) must be used directly.

## 3. Runtime model: two processes

The code runs in two separate processes and nothing outside `src/shared/` may
bridge them.

1. **gnome-shell process** — `extension.js` is the entry point. It owns the
   panel UI, the D-Bus tray sources and every interaction with the live shell.
   Importing `resource:///org/gnome/shell/ui/main.js` is only legal here.
2. **Preferences process** (`gnome-shell-extension-prefs`) — `prefs.js` is the
   entry point. It renders an Adwaita window and must never import shell-only
   modules; `gi://Shell` and `resource:///org/gnome/shell/ui/*` are not
   available there.

Both processes read and write the same GSettings keys. The largest one,
`app-configs`, is a JSON blob that each side parses on demand (never cached
across a write), so every change propagates through the `changed::app-configs`
signal and both sides re-render.

## 4. Repository layout

```
extension.js              # shell entry point: enable()/disable(), wiring, auto-sync
prefs.js                  # prefs entry point: window, icon theme, page list
metadata.json             # manifest: uuid, shell versions, conflicts, gettext domain
AGENTS.md / README.md / CONTRIBUTING.md / CHANGELOG.md
schemas/                  # GSettings schema (single file, includes the app-configs JSON shape)
interfaces/               # D-Bus introspection XML: StatusNotifierItem, Watcher, DBusMenu
po/                       # translation sources (de, it, ru, zh_CN) + POTFILES.in
assets/                   # bundled SVG icons + logo, shipped in the zip and loaded by prefs
media/                    # README screenshots and listing icons, not shipped
src/
├── const.js              # values both processes need: key lists, ranges, defaults
├── shared/               # reachable from BOTH processes
│   ├── appConfig.js      # the per-app config store: read/write/merge/migrate (core data model)
│   ├── settingsIO.js     # export/import JSON, sync file writes, backups, sanitising
│   ├── iconLoading.js    # icon resolution + symbolic tinting, usable from prefs
│   ├── lifecycle.js      # clearIds/disposeAll/disconnectAll/debounceTo/ruleDispatcher
│   ├── asyncIo.js        # async file/proc readers
│   ├── logging.js        # warn/warnOnce/error with keyed de-duplication
│   ├── colorVariant.js, accentColor.js, colorContrast.js, boxStyle.js
│   └── api/ids.js        # Better Panel handshake constants
├── shell/                # runs inside gnome-shell
│   ├── sni/              # StatusNotifierItem source: watcher, per-item icon, dbusmenu client
│   ├── xembed/           # XEmbed source for Wine/Proton apps
│   ├── backgroundAppsProxy/  # proxy tray icons for windowless background apps
│   ├── components/       # panel indicator, toggle button, overflow popup
│   ├── features/         # clicks, drag&drop, tooltip, window activation, quick-settings
│   ├── identity/         # process → app id resolution, packaging, multi-item split
│   ├── icons/            # icon resolver and icon/badge content
│   ├── api/              # Better Panel integration (applet registration)
│   ├── dbusCalls.js, popupMenus.js, trayStyle.js, actorPlacement.js, disposal.js
└── prefs/                # runs inside the preferences window
    ├── pages/            # general, appearance, actions, applications, about, sync dialog
    ├── subpages/         # per-surface styling: tray icons, toggle button, overflow menu
    ├── dialogs/          # app editor, action config, status badges
    ├── components/       # rows, buttons, cards, colors, badge, sidebar, scenes/* previews
    └── stylesheet.css
```

## 5. Shell-side architecture

### Startup sequence (`extension.js`)

`enable()` builds `ApiHub` first (a peer that looks immediately must find it),
then defers the rest by one idle iteration so a conflicting tray extension can
release the SNI bus names. `_realEnable()` then, in order: load the interface
XML, get settings, run the legacy placement migration, wire auto-sync/auto-push,
create `PanelIndicator` + `TrayButton` and place them in the panel, enable the
LauncherEntry subscription, start `SniWatcher`, `XEmbedTrayBridge`,
`BackgroundApps` and `BackgroundAppsProxyWatcher`.

`disable()` mirrors every step: destroy the API and panel guest, clear timers
and signals, dispose watchers and the indicator, unsubscribe the LauncherEntry
signal, drop the menu layer, icon caches, seen-state caches and item splits.
Anything not undone here leaks into the live shell and fails review.

### Panel stack (`src/shell/components/`)

```
Main.panel.statusArea
└── TrayButton (PanelMenu.Button, role 'bti-tray')   # trayButton.js, placeIndicatorInPanel()
    └── PanelIndicator (St.BoxLayout)                # panelIndicator.js
        ├── visible box          # icons whose app stays in the panel
        ├── ToggleButton         # toggleButton.js: open popup, cycle, action menu, prefs
        └── OverflowMenu         # overflowMenu.js: flow layout (grid/row), geometry pinned to style
```

`PanelIndicator._updateLayout()` is the heart of placement. It sorts live icons
by per-app priority, drops hidden/passive ones, partitions them by the per-app
`in_overflow` flag into panel and popup, shows or hides the toggle, pins popup
geometry and publishes the visible order to the runtime dir for the prefs.

- **Per-app placement**: which surface an icon lives on is stored on the app
  (`in_overflow`), not derived from a count. The legacy `visible-icon-limit`
  count is only read once by `migrateOverflowSelection()` to reproduce the old
  split on upgrade.
- **Drag & drop** (`features/dragAndDrop.js`, `features/dropTarget.js`): the
  indicator is the drop target. Crossing containers writes the placement,
  dropping within one writes the order (`setAppPriorities`).
- **Cycle action** rotates the boundary: one panel icon folds as one popup icon
  unfolds, so the panel width is stable.

### Tray icon sources

Three independent sources feed the same layout, each with its own module.

- **SNI** (`sni/`): `SniWatcher` owns the `org.kde`/`org.freedesktop`
  StatusNotifierWatcher names, answers registration, watches item bus names and
  creates a `TrayIcon` per item. `TrayIcon` identifies the app, resolves the
  icon, serves the menu (`DBusMenuClient` for com.canonical.dbusmenu, with a
  fallback to the app's own `ContextMenu`) and executes click actions.
- **XEmbed** (`xembed/`): legacy Wine/Proton icons, forwarded clicks included,
  gated by `enable-wine-support`.
- **Background app proxies** (`backgroundAppsProxy/`): creates tray icons for
  windowless flatpaks via the portal, with desktop actions, status line and
  quit. `features/backgroundApps.js` can additionally hide GNOME's own
  Quick Settings entry.

### Activation rules (`sni/trayIcon.js` + `features/launcherEntries.js`)

`_activate()` decides what a click means:

1. No running app with windows → the app's own `ActivateRemote`.
2. The icon is alerting (`_hasAlert`, set from `detected.hasAlert`, which covers
   `NeedsAttention` and any icon that drifted from its calm baseline) **and** the
   item's window already has focus (`isAppInFront`) → `ActivateRemote` again,
   because a raise would be a no-op and only the app knows which chat or dialog
   the alert stands for.
3. Otherwise → `raiseApp(app, pid)`: `Main.activateWindow` on the window owned
   by the item's process when the app's windows span several processes (two
   instances of one app share a `Shell.App`, and its own pick is the most
   recently used one, not necessarily this icon's), else the app-level
   activation. This also crosses workspaces and dismisses the overview.

`launcherEntries.js` also tracks `com.canonical.Unity.LauncherEntry` updates to
drive unread badges, keyed by desktop id and by sender pid.

### Identity (`identity/`)

An app id comes from the process first (`/proc/<pid>/cmdline` via the D-Bus
daemon's `GetConnectionUnixProcessID`), then the SNI `Id`, icon theme path,
icon name and title. `packaging.js` detects flatpak/snap/AppImage wrappers;
`appId.js` sanitises and picks; `itemSplit.js` gives several items published by
one process distinct `base@discriminator` ids so their settings do not collide.
Legacy ids migrate through `migrateLegacyConfig()`.

### Icons (`icons/` + `shared/iconLoading.js`)

`resolveTrayIcon()` handles: status (Active/Passive/NeedsAttention), alert
detection against the calm baseline, custom and per-state icons, theme lookup
(including the app's own `IconThemePath`), pixmap → PNG conversion with a size
cap, symbolic tinting, and snapshot caching into the app config so the prefs can
render without the app running. `iconContent.js` applies the result and the
unread badge to the St actor.

## 6. Data model and settings

### `app-configs` (JSON string in GSettings)

One entry per detected app, keyed by app id. Documented in the schema and
authoritatively shaped in `shared/appConfig.js`:

| Field | Meaning |
| --- | --- |
| `title`, `custom_title` | detected name and user rename |
| `custom_icon`, `detected_icon`, `icon_theme_path`, `cached_icon_path` | icon override, baseline, theme root, snapshot cache |
| `detected_icon_hash`, `seen_icons`, `state_icons`, `unread_badge`, `badge_style` | alert baseline, seen states, per-state icons, badge |
| `is_hidden` | not shown on either surface |
| `in_overflow` | `true` folds the icon into the overflow popup; absent means the panel |
| `priority` | higher first, written in bulk by `setAppPriorities()` |
| `is_wine`, `is_proton`, `is_xembed`, `is_background_proxy`, `packaging` | source and packaging hints |
| `migrated_to` | bookkeeping for legacy key copies |

`RUNTIME_APP_CONFIG_FIELDS` are written by the shell itself and excluded from
the user-config signature and the sync hash; everything else is user data and
travels through sync. Untrusted JSON (sync file, hand edit) is sanitised:
reserved prototype keys dropped, icon paths probed, badge fields validated.

### Other keys

Everything lives in `schemas/org.gnome.shell.extensions.bettertrayicons.gschema.xml`
— the schema is the single source of truth for names, types, ranges and
defaults. Groups: behaviour switches (`enable-*`, `keep-popup-*`, `hide-background-apps`),
tooltips, per-surface styling (`icon-*`, `toggle-*`, `overflow-container-*` with
`-light` twins and `*-linked` padding/margin links), placement
(`tray-position`, `tray-order`), overflow layout (`overflow-layout-mode`,
`grid-column-limit`), actions (`tray-action-*`, `toggle-action-*`,
`toggle-hover-menu`), sync (`sync-file-path`, `enable-auto-sync`, `max-backups`)
and the legacy pair `visible-icon-limit` + `overflow-selection-migrated`.

### Sync and backups

`settingsIO.js` exports every schema key (icons collapsed to `$HOME` paths) plus
`_app_config_meta`; importing merges last-writer-wins per entry using stamps and
content hashes, with tombstones so a forget propagates. `extension.js` monitors
the sync file (1 s debounce pull) and pushes user-driven changes (2 s debounce),
never its own echo. Backups are `<path>.<micros>.gz` next to the file, capped by
`max-backups`.

## 7. Preferences architecture

`prefs.js` builds the window, adds the bundled icon theme path and hands the
page list to `components/sidebar.js`, which owns navigation, header reset
buttons and toasts. Pages are self-contained `Adw.PreferencesPage` subclasses;
each exposes `headerActions` for the per-page reset. Reusable controls live in
`components/` (`row.js` is the largest: spin/switch/combo/segmented/action rows
and the wrap layout); `components/scenes/` renders the little panel previews on
the placement cards. Per-app editing happens in `dialogs/appDialog.js` and its
sub-dialogs.

Prefs must not import from `src/shell/`; anything both sides need belongs in
`src/shared/`.

## 8. Conventions that hold the codebase together

- **Lifecycle helpers, not raw GObject bookkeeping**: `clearIds`,
  `disposeAll`, `disconnectAll`, `disconnectSignal`, `debounceTo`, `removeTimer`
  from `shared/lifecycle.js`, plus `trackDisposal`/`isDisposed` from
  `shell/disposal.js` and `_guarded()` callbacks on async paths. Rebuilds and
  rebases re-run `enable()` on live modules, so state must be re-derived, and
  timers must check disposal before acting.
- **Async races are handled explicitly**: generation counters (`_updateGen`,
  `_titleGen`) so a slow D-Bus answer cannot overwrite a newer frame, and
  `_swallow()` for fire-and-forget promises with a labelled warning.
- **No synchronous I/O on the main loop**; use the `*_async` variants. Pixmap
  and network-ish work is capped and throttled (see `iconResolver.js`).
- **Comments explain why, never what.** Nearly every non-obvious line carries a
  sentence about the app behaviour or shell quirk that forced it. Keep new code
  in that style, and put module constants at the top with a comment.
- **User-facing strings** go through `_()` from gettext; new files must be added
  to `po/POTFILES.in`.
- **Keys, ranges and defaults** come from the schema; `const.js` only carries
  what both processes need or bounds the schema cannot express.
- **Reuse before new abstractions**: check `src/shared/` and
  `src/prefs/components/` first.

## 9. Rules for changes (from CONTRIBUTING.md)

- Significant changes are discussed in an issue first; one topic per PR.
- Shell-side code follows the [GNOME extensions review
  guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html):
  full teardown in `disable()`, no synchronous I/O, no bundled third-party
  libraries, no runtime dependencies on external packages.
- **No AI-generated code.** Every submitted line must be justifiable on review;
  bulk AI output (boilerplate, imaginary APIs, prompt-like comments) is rejected.
- Commits use Conventional Commits (`feat`, `fix`, `i18n`, `refactor`, `docs`,
  `style`, `test`, `chore`); the type drives the version bump, so translations
  use `i18n:`. Subjects under 72 characters, imperative, body explains why.
- `npm test` must pass before a PR; CI runs ESLint plus the schema and
  translation checks.
- Feature requests and bug reports go through the issue tracker with the wiki
  templates; translations follow the Translation Guidelines on the wiki.

## 10. Task → module map

| Change | Touch |
| --- | --- |
| Panel placement, overflow split, drag between surfaces | `shell/components/panelIndicator.js`, `shared/appConfig.js` |
| Click/double/long-press behaviour | `shell/features/clickController.js`, action keys in the schema, `prefs/pages/actionPage.js` |
| What a click does to a window | `shell/sni/trayIcon.js` (`_activate`), `shell/features/launcherEntries.js` |
| Icon rendering, badges, state icons | `shell/icons/iconResolver.js`, `shell/icons/iconContent.js`, `shared/iconLoading.js` |
| App identification, dual instances, packaging | `shell/identity/*` |
| A new setting | schema key → reading module → prefs page/subpage → reset key list for that page |
| Styling of icons, toggle, popup | `shell/trayStyle.js`, `shared/boxStyle.js`, `shared/colorVariant.js`, `prefs/subpages/*` |
| Sync, import/export | `shared/settingsIO.js`, `extension.js` (monitor/push), `prefs/pages/generalPage.js` |
| Preferences UI | `prefs/pages/*`, `prefs/subpages/*`, `prefs/components/*` |
| Translations | `po/*.po`, `po/POTFILES.in` when adding files |

## 11. Gotchas

- Two items can share an app id (split ids aside); placement, hiding and
  priority are per app, and the layout signature is keyed per item.
- The prefs process sees the config blob for every app ever seen, not only the
  running ones; counts derived from it can exceed the panel.
- The runtime `visible-order.json` (written by the indicator) is the only source
  that matches the live panel; the config's own priorities include closed apps.
- `app-configs` writes fan out to both processes and re-render; batch related
  writes (`setAppPriorities`, `mutateAppConfig`) instead of looping per key.
- `Main.panel.statusArea` keeps the registration role, so moving the tray means
  moving the container, not re-adding it (`trayButton.js`).
- D-Bus peers are untrusted: property types, signatures and icon names are
  validated before use throughout `sni/` and `icons/`. Keep it that way.
