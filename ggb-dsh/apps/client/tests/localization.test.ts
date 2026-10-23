import { describe, expect, it } from 'vitest'

import { defaultSessionTitle, localeFromBrowser, text } from '../src/app/localization.js'
import { initialProjectedState } from '../src/runtime/run-state.js'
import { credentialRequiredNotice, describeRunStatus } from '../src/app/run-status.js'

describe('browser presentation locale', () => {
  it('keeps credential notices consistent with local key readiness', () => {
    expect(credentialRequiredNotice(true, 'zh-CN')).toContain('Key 已就绪')
    expect(credentialRequiredNotice(false, 'zh-CN')).toContain('请在设置中保存')
  })

  it('shows a plugin-core failure detail without trusting notice text', () => {
    const run = initialProjectedState('run-failed', 'failed')
    run.failure = { code: 'provider_error', message: 'provider call failed' }
    expect(describeRunStatus(run, true, 0, 'en').detail).toBe('provider call failed')
    expect(describeRunStatus(run, true, 0, 'zh-CN').tone).toBe('error')
    expect(credentialRequiredNotice(false, 'zh-CN')).toContain('请在设置中保存')
    expect(credentialRequiredNotice(true, 'en')).toContain('The key is available')
  })

  it('selects simplified Chinese only for a Chinese browser preference', () => {
    expect(localeFromBrowser(['zh-CN', 'en-US'])).toBe('zh-CN')
    expect(localeFromBrowser(['en-GB', 'zh-CN'])).toBe('en')
    expect(localeFromBrowser(['en-US'])).toBe('en')
  })

  it('uses the selected locale in the UI and status bar', () => {
    expect(defaultSessionTitle('zh-CN')).toBe('新会话')
    expect(text('en', 'sessions')).toBe('Sessions')
    expect(text('zh-CN', 'toolSessions')).toBe('会话')
    expect(text('zh-CN', 'toolAssistant')).toBe('助手')
    expect(text('zh-CN', 'about')).toBe('关于')
    expect(text('zh-CN', 'licenseNotice')).toContain('MIT License')
    expect(text('zh-CN', 'authors')).toBe('李均强和谭枫教授团队共同创作')
    expect(text('zh-CN', 'email')).toBe('电子邮箱')
    expect(text('en', 'about')).toBe('About')
    expect(text('en', 'authors')).toBe('Created by Li Junqiang and Professor Tan Feng’s team')
    expect(text('en', 'licenseNotice')).toContain('MIT License for mathematics education and research')
    expect(text('en', 'email')).toBe('Email')
    expect(describeRunStatus(undefined, true, 0, 'zh-CN').label).toBe('准备就绪')
    expect(describeRunStatus(undefined, true, 0, 'en').label).toBe('Ready')
  })

})
