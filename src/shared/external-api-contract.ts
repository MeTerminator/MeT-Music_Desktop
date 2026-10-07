import { z } from "zod";

const position = z.number().finite().min(0);
export const ExternalStateEventSchema = z.strictObject({
    state: z.enum(["playing", "paused", "stopped"]),
    position,
    duration: position
});
export const ExternalTrackEventSchema = z.strictObject({
    id: z.union([z.string(), z.number()]),
    name: z.string(),
    artist: z.string(),
    cover: z.string().optional(),
    duration: position
});
export const ExternalProgressEventSchema = z.strictObject({
    position,
    duration: position,
    lyricText: z.string()
});
export const ExternalEventSchemas = {
    state: ExternalStateEventSchema,
    track: ExternalTrackEventSchema,
    progress: ExternalProgressEventSchema
} as const;
export type ExternalEventType = keyof typeof ExternalEventSchemas;
export type ExternalEventData<T extends ExternalEventType> = z.infer<(typeof ExternalEventSchemas)[T]>;

export const SeekBodySchema = z.strictObject({ positionMs: position });
export const VolumeBodySchema = z.strictObject({ volume: z.number().finite().min(0).max(1) });
const simpleOps = ["play", "pause", "stop", "next", "prev"] as const;
export const ExternalCommandSchema = z.discriminatedUnion("op", [
    z.strictObject({ op: z.enum(simpleOps) }),
    SeekBodySchema.extend({ op: z.literal("seek") }),
    VolumeBodySchema.extend({ op: z.literal("setVolume") })
]);
export type ExternalCommand = z.infer<typeof ExternalCommandSchema>;
const ExternalEventMessageSchema = z.discriminatedUnion("type", [
    z.strictObject({ kind: z.literal("event"), type: z.literal("state"), data: ExternalStateEventSchema }),
    z.strictObject({ kind: z.literal("event"), type: z.literal("track"), data: ExternalTrackEventSchema }),
    z.strictObject({ kind: z.literal("event"), type: z.literal("progress"), data: ExternalProgressEventSchema })
]);
export const ExternalServerMessageSchema = z.union([
    z.strictObject({ kind: z.literal("hello"), clients: z.number().int().min(0) }),
    z.strictObject({ kind: z.literal("ack"), op: z.enum([...simpleOps, "seek", "setVolume"]) }),
    z.strictObject({ kind: z.literal("error"), op: z.string().nullable(), error: z.string() }),
    ExternalEventMessageSchema
]);
export type ExternalServerMessage = z.infer<typeof ExternalServerMessageSchema>;
