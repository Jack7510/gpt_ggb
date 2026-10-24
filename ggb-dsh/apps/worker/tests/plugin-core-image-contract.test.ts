import { expect, it } from 'vitest'
import { PluginCoreImageInputContract } from '../src/plugin-core/image-input-contract.js'

it('uses trusted image presence, not prompt words or model flags, and commits only after a valid save', () => {
  const image = new PluginCoreImageInputContract(true)
  for (const args of [null, {}, { requestText: '{}', imageAttached: false },
    { requestText: '{}', transcription: [] }, { requestText: '{}', transcription: ['  '] },
    { requestText: '{}', transcription: [1] }, { action: 'create', transcription: ['point P'] }]) {
    expect(image.canSave(args)).toBe(false)
  }
  expect(image.canSave({ requestText: '{}', transcription: ['point P'] })).toBe(true)
  expect(image.canSave({ requestText: '{}' })).toBe(false) // Validation alone is not a save.
  image.accepted()
  expect(image.canSave({ requestText: '{}' })).toBe(true)
  expect(image.canSave({ requestText: '{}', transcription: [] })).toBe(false)
  expect(image.canSave({ requestText: '{}', transcription: ['replacement'] })).toBe(true)
  expect(new PluginCoreImageInputContract(true).canSave({ requestText: '{}' })).toBe(false)
  expect(new PluginCoreImageInputContract(false).canSave({ requestText: '{}' })).toBe(true)
})
