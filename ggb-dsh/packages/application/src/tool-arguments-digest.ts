import { createHash } from 'node:crypto'
import { canonicalJson } from './canonical-json.js'

/** Digest model-provided tool arguments before reserving a request. */
export function toolArgumentsDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}
