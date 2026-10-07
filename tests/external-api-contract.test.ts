import { test } from "node:test";
import assert from "node:assert/strict";
import { ExternalCommandSchema, ExternalServerMessageSchema, ExternalEventSchemas, SeekBodySchema, VolumeBodySchema } from "../src/shared/external-api-contract.ts";

test("commands enforce op-specific payloads", () => {
    assert.deepEqual(ExternalCommandSchema.parse({ op: "seek", positionMs: 1200 }), { op: "seek", positionMs: 1200 });
    for (const command of [
        { op: "seek" }, { op: "seek", positionMs: -1 },
        { op: "seek", positionMs: 1, volume: 0.5 },
        { op: "play", positionMs: 1 }, { op: "setVolume", volume: 2 },
        { op: "invalid" }
    ]) assert.equal(ExternalCommandSchema.safeParse(command).success, false);
});

test("HTTP seek/volume bodies reject unknown and non-finite data", () => {
    assert.equal(SeekBodySchema.safeParse({ positionMs: Infinity }).success, false);
    assert.equal(VolumeBodySchema.safeParse({ volume: 0.5, extension: true }).success, false);
    assert.equal(VolumeBodySchema.safeParse({ volume: 0 }).success, true);
});

test("event data is bound to its event type", () => {
    const state = { state: "paused", position: 0, duration: 1000 };
    assert.equal(ExternalEventSchemas.state.safeParse(state).success, true);
    assert.equal(ExternalEventSchemas.track.safeParse(state).success, false);
    assert.equal(ExternalEventSchemas.progress.safeParse({ position: 0, duration: 1000 }).success, false);
    assert.equal(ExternalEventSchemas.state.safeParse({ ...state, undocumented: true }).success, false);
});

test("server envelopes enforce event-specific data", () => {
    assert.equal(ExternalServerMessageSchema.safeParse({ kind: "hello", clients: 1 }).success, true);
    assert.equal(ExternalServerMessageSchema.safeParse({ kind: "ack", op: "unknown" }).success, false);
    assert.equal(ExternalServerMessageSchema.safeParse({ kind: "event", type: "track", data: { position: 0, duration: 1000 } }).success, false);
});
