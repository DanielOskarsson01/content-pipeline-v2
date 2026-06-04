-- Section C (2026-06-04): drop the apply_entity_routing tripwire stub.
--
-- migration_multi_card_pattern.sql (lines 283-284) dropped both overloads of
-- the original apply_entity_routing function. Commit ed5c031 restored the
-- 3-arg version as a loud-fail stub guarding production until Section C
-- rewrote the JS caller. Section C is now landing — the JS caller is gone
-- (routingHandler.js no longer references apply_entity_routing), and the stub
-- has no remaining callers.
--
-- This drop is atomic with the JS rewrite: both ship in the same commit so
-- prod cannot end up in a state where the stub is gone but the JS still
-- references it (or vice versa).
--
-- Signature matches the stub at sql/restore_apply_entity_routing_stub.sql:48
-- — (UUID, JSONB, INTEGER). Idempotent: IF EXISTS guards re-running.

DROP FUNCTION IF EXISTS apply_entity_routing(uuid, jsonb, integer);
