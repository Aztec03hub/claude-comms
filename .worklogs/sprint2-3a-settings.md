# Sprint 2 - Agent 3A: Settings Panel

## Task
Create SettingsPanel component and wire settings buttons in App.svelte and Sidebar.svelte.

## Changes Made

### NEW: `web/src/components/SettingsPanel.svelte`
- Slide-out panel matching SearchPanel positioning/animation (right side, 380px wide)
- **Profile section**: editable display name input, read-only participant key
- **Notifications section**: toggle switches for desktop notifications and in-app toasts
- **Appearance section**: current theme label (dark/light)
- **Connection section**: broker URL display, connection status with green/red indicator
- Carbon Ember styling consistent with SearchPanel and other panels
- `data-testid="settings-panel"` and `data-testid="settings-panel-close"` applied
- Accessible: aria-labels on toggles, label associations on inputs

### MODIFIED: `web/src/App.svelte`
- Added `import SettingsPanel`
- Added `let showSettingsPanel = $state(false);`
- Wired header settings button: `onclick={() => showSettingsPanel = !showSettingsPanel}`
- Added `{#if showSettingsPanel}<SettingsPanel>` render block after SearchPanel
- Added `showSettingsPanel` to Escape priority chain (after search, before thread)
- Passed `onOpenSettings` prop to Sidebar

### MODIFIED: `web/src/components/Sidebar.svelte`
- Added `onOpenSettings` to destructured `$props()`
- Wired user settings gear button: `onclick={() => onOpenSettings()}`

## Coordination
- Read App.svelte and Sidebar.svelte fresh after Agent 3D's modifications
- Did NOT touch: context action handlers, mute buttons, showMemberList, showDeleteConfirm (3D's territory)

## Verification
- `npx vite build` passes successfully
