import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { ExternalCommandSchema, ExternalServerMessageSchema, ExternalEventSchemas, SeekBodySchema, VolumeBodySchema } from '../src/shared/external-api-contract.ts';
import { PlaybackSnapshotSchema, NowPlayingSchema, LyricsSnapshotSchema } from '../src/shared/hook-contract.ts';

const schemas = {
  wsCommand: ExternalCommandSchema,
  wsServer: ExternalServerMessageSchema,
  httpSeek: SeekBodySchema,
  httpVolume: VolumeBodySchema,
  httpStatus: PlaybackSnapshotSchema.strict(),
  httpNowPlaying: NowPlayingSchema.strict(),
  httpLyrics: LyricsSnapshotSchema.strict(),
  ...Object.fromEntries(Object.entries(ExternalEventSchemas).map(([key, value]) => [`event_${key}`, value]))
};
writeFileSync(new URL('../docs/external-api.schema.json', import.meta.url), JSON.stringify(Object.fromEntries(Object.entries(schemas).map(([key, value]) => [key, z.toJSONSchema(value)])), null, 2) + '\n');
