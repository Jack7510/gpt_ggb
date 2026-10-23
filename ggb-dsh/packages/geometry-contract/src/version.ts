import { z } from 'zod'

/** Current geometry JSON schema generation. */
export const GEOMETRY_SCHEMA_VERSION = 1 as const

/** Rejects payloads from unknown geometry schema generations. */
export const geometrySchemaVersion = z.literal(GEOMETRY_SCHEMA_VERSION)
