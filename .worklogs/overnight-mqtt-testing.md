# Overnight MQTT Integration Testing

**Agent:** MQTT Integration Tester
**Started:** 2026-03-29
**Baseline:** 201 tests passing

## Round 1: Broker Lifecycle

**Status:** In progress

### Plan
- Test EmbeddedBroker.from_config() with various configs
- Test MessageDeduplicator edge cases (overflow, LRU, concurrent)
- Test MessageStore with multiple conversations, cap enforcement
- Test replay_jsonl_logs with valid/invalid/empty JSONL files
- Test generate_client_id uniqueness and validation
