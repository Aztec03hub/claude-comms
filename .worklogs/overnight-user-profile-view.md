# Work Log: User Profile View Component

**Date:** 2026-03-29
**Task:** Fix UX issue where "View Profile" on someone's profile card incorrectly opens your own settings panel

## Problem
Clicking "View Profile" on any user's ProfileCard always opened the SettingsPanel (your own settings). This was confusing because users expected to see information about the person they clicked on.

## Changes Made

### New Component: `web/src/components/UserProfileView.svelte`
- Slide-out panel matching SettingsPanel/SearchPanel style (same animation, width, Carbon Ember palette)
- Displays: large 64px avatar with color gradient, name in sender color, @handle, role badge, type indicator (Human/Claude), participant key (monospace), online/offline status with dot
- Actions section: "Send Message" button (closes panel, pre-fills @name in input), "Mute Notifications" toggle (placeholder)
- Test IDs: `user-profile-view`, `user-profile-view-close`

### Updated: `web/src/App.svelte`
- Added `showUserProfileView` and `userProfileTarget` state variables
- Imported `UserProfileView` component
- Updated `onViewProfile` handler in ProfileCard render block:
  - Own profile (matching key) → opens SettingsPanel (preserved behavior)
  - Other user's profile → opens UserProfileView with their data
- Added UserProfileView render block with `onSendMessage` handler (same @mention pre-fill logic as ProfileCard's onMessage)
- Added UserProfileView to Escape priority chain (after ProfileCard, before PinnedPanel)

### No changes needed: `web/src/components/ProfileCard.svelte`
- Already passes participant to `onViewProfile` callback correctly

## Verification
- `npx vite build` passes (only pre-existing warnings, no new issues)
