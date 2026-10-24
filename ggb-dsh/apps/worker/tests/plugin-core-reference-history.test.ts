import { expect, it, vi } from 'vitest'
import { PluginCoreReferenceHistory } from '../src/plugin-core/reference-history.js'

it('never marks failed or malformed reads available and never retains reference text', async () => {
  const history = new PluginCoreReferenceHistory(['request'])
  const load = vi.fn().mockRejectedValueOnce(new Error('read_failed'))
    .mockResolvedValueOnce(null).mockResolvedValue({ references: [{ topic: 'program', content: 'PRIVATE_REFERENCE' }] })
  await expect(history.read(['request', 'program'], load)).rejects.toThrow('read_failed')
  await expect(history.read(['program'], load)).rejects.toThrow('reference_result_invalid')
  expect(await history.read(['program', 'request'], load)).toMatchObject({ alreadyAvailable: ['request'] })
  expect(load).toHaveBeenCalledTimes(3)
  expect(await history.read(['program'], load)).toEqual({ alreadyAvailable: ['program'], note: expect.any(String) })
  expect(load).toHaveBeenCalledTimes(3)
  expect(JSON.stringify(history)).not.toContain('PRIVATE_REFERENCE')
  const other = new PluginCoreReferenceHistory()
  await other.read(['program'], load)
  expect(load).toHaveBeenCalledTimes(4)
  await history.read(['program'], load, true)
  expect(load).toHaveBeenCalledTimes(5)
})

it('checks complete topic identities and the final escaped response budget before marking availability', async () => {
  const history = new PluginCoreReferenceHistory(['request'], 100)
  await expect(history.read(['program'], async () => ({ topic: 'wrong', content: 'x' })))
    .rejects.toThrow('reference_result_invalid')
  await expect(history.read(['program'], async () => ({ topic: 'program', content: '' })))
    .rejects.toThrow('reference_result_invalid')
  await expect(history.read(['request', 'program'], async () => ({ topic: 'program', content: '"'.repeat(35) })))
    .rejects.toThrow('reference_response_oversized')
  const read = vi.fn(async () => ({ topic: 'program', content: 'x' }))
  expect(await history.read(['program'], read)).toEqual({ topic: 'program', content: 'x' })
  expect(read).toHaveBeenCalledOnce()
})
