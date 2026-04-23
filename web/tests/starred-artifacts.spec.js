// Tests for lib/starredArtifacts.js — the scoped-localStorage helpers
// that persist per-user, per-conversation star state for artifacts.
//
// Covers R2-8 (per-identity scoping), the 500 FIFO cap, and the
// reconcile() pruning behavior called on panel mount.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadStarred,
  toggleStar,
  reconcile,
  __STAR_CAP_PER_CONVERSATION,
} from '../src/lib/starredArtifacts.js';

// jsdom provides a real localStorage we can clear between tests.
beforeEach(() => {
  localStorage.clear();
});

describe('starredArtifacts', () => {
  describe('loadStarred', () => {
    it('returns an empty array when no entry exists', () => {
      expect(loadStarred('identity-A', 'general')).toEqual([]);
    });

    it('returns an empty array for missing identity or conversation', () => {
      expect(loadStarred('', 'general')).toEqual([]);
      expect(loadStarred('identity-A', '')).toEqual([]);
      expect(loadStarred(null, null)).toEqual([]);
    });

    it('returns the persisted list for the (identity, conversation) pair', () => {
      toggleStar('identity-A', 'general', 'artifact-one');
      toggleStar('identity-A', 'general', 'artifact-two');
      expect(loadStarred('identity-A', 'general')).toEqual([
        'artifact-one',
        'artifact-two',
      ]);
    });

    it('returns a fresh copy (mutating it does not affect storage)', () => {
      toggleStar('identity-A', 'general', 'alpha');
      const list = loadStarred('identity-A', 'general');
      list.push('should-not-persist');
      expect(loadStarred('identity-A', 'general')).toEqual(['alpha']);
    });

    it('silently recovers from corrupt JSON', () => {
      localStorage.setItem(
        'claude-comms:identity-A:starred-artifacts',
        '{not valid json}',
      );
      expect(loadStarred('identity-A', 'general')).toEqual([]);
    });
  });

  describe('toggleStar', () => {
    it('adds the name and returns true on first toggle', () => {
      const now = toggleStar('identity-A', 'general', 'spec-doc');
      expect(now).toBe(true);
      expect(loadStarred('identity-A', 'general')).toEqual(['spec-doc']);
    });

    it('removes the name and returns false on second toggle', () => {
      toggleStar('identity-A', 'general', 'spec-doc');
      const now = toggleStar('identity-A', 'general', 'spec-doc');
      expect(now).toBe(false);
      expect(loadStarred('identity-A', 'general')).toEqual([]);
    });

    it('does not cross-contaminate different conversations', () => {
      toggleStar('identity-A', 'general', 'alpha');
      toggleStar('identity-A', 'random', 'beta');
      expect(loadStarred('identity-A', 'general')).toEqual(['alpha']);
      expect(loadStarred('identity-A', 'random')).toEqual(['beta']);
    });

    it('persists multiple additions in insertion order', () => {
      toggleStar('identity-A', 'general', 'one');
      toggleStar('identity-A', 'general', 'two');
      toggleStar('identity-A', 'general', 'three');
      expect(loadStarred('identity-A', 'general')).toEqual([
        'one',
        'two',
        'three',
      ]);
    });

    it('returns false for empty inputs without writing anything', () => {
      expect(toggleStar('', 'general', 'x')).toBe(false);
      expect(toggleStar('identity-A', '', 'x')).toBe(false);
      expect(toggleStar('identity-A', 'general', '')).toBe(false);
      expect(localStorage.length).toBe(0);
    });
  });

  describe('reconcile', () => {
    it('drops stale entries whose names are not in the existing set', () => {
      toggleStar('identity-A', 'general', 'keep-me');
      toggleStar('identity-A', 'general', 'delete-me');
      const cleaned = reconcile('identity-A', 'general', ['keep-me', 'other']);
      expect(cleaned).toEqual(['keep-me']);
      expect(loadStarred('identity-A', 'general')).toEqual(['keep-me']);
    });

    it('returns an empty array when no stored entries exist', () => {
      const cleaned = reconcile('identity-A', 'general', ['a', 'b']);
      expect(cleaned).toEqual([]);
    });

    it('is a no-op when all stored entries are still present', () => {
      toggleStar('identity-A', 'general', 'one');
      toggleStar('identity-A', 'general', 'two');
      const cleaned = reconcile('identity-A', 'general', [
        'one',
        'two',
        'three',
      ]);
      expect(cleaned).toEqual(['one', 'two']);
    });

    it('enforces the 500-entry FIFO cap', () => {
      // Manually seed a 600-entry list to exercise the cap (more than the
      // per-toggle insertion path allows).
      const bigList = Array.from({ length: 600 }, (_, i) => `artifact-${i}`);
      localStorage.setItem(
        'claude-comms:identity-A:starred-artifacts',
        JSON.stringify({ general: bigList }),
      );
      // All 600 names are still present in the conversation.
      const cleaned = reconcile('identity-A', 'general', bigList);
      expect(cleaned.length).toBe(__STAR_CAP_PER_CONVERSATION);
      expect(cleaned.length).toBe(500);
      // FIFO drop: the oldest 100 should be gone, the most recent 500 kept.
      expect(cleaned[0]).toBe('artifact-100');
      expect(cleaned[cleaned.length - 1]).toBe('artifact-599');
    });

    it('handles iterables besides arrays (e.g., Set)', () => {
      toggleStar('identity-A', 'general', 'alpha');
      toggleStar('identity-A', 'general', 'beta');
      const cleaned = reconcile('identity-A', 'general', new Set(['alpha']));
      expect(cleaned).toEqual(['alpha']);
    });
  });

  describe('scoping by identity', () => {
    it('different identity keys get different storage', () => {
      toggleStar('identity-A', 'general', 'shared-name');
      toggleStar('identity-B', 'general', 'B-only');

      expect(loadStarred('identity-A', 'general')).toEqual(['shared-name']);
      expect(loadStarred('identity-B', 'general')).toEqual(['B-only']);
    });

    it('unstarring in one identity does not affect another', () => {
      toggleStar('identity-A', 'general', 'x');
      toggleStar('identity-B', 'general', 'x');
      toggleStar('identity-A', 'general', 'x'); // unstar for A
      expect(loadStarred('identity-A', 'general')).toEqual([]);
      expect(loadStarred('identity-B', 'general')).toEqual(['x']);
    });

    it('reconcile is per-identity', () => {
      toggleStar('identity-A', 'general', 'keep');
      toggleStar('identity-A', 'general', 'drop');
      toggleStar('identity-B', 'general', 'drop'); // same name, different identity

      reconcile('identity-A', 'general', ['keep']);
      expect(loadStarred('identity-A', 'general')).toEqual(['keep']);
      // B's list is untouched
      expect(loadStarred('identity-B', 'general')).toEqual(['drop']);
    });
  });
});
