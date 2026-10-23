import type { PresentationLocale } from '@ggb-copilot/application/browser'

export type UiTextKey = keyof typeof EN

const EN = {
  copyRecord: 'Copy record', constructionRecord: 'Construction steps and changes', downloadRecord: 'Download record', constructionDownloadFailed: 'Could not download the record.',
  buildNotAttempted: 'No build attempted', buildStructureRejected: 'Request structure rejected',
  buildExecutionFailed: 'Build execution failed', buildVerificationFailed: 'Verification failed', lastBuild: 'Last build',
  imageReading: 'Reading image…', attachImage: 'Attach image', removeImage: 'Remove image', imageOnlyPrompt: 'Construct the geometry described in this image.',
  imageInvalid: 'Choose one valid PNG/JPEG, up to 3 MiB and 20 megapixels.',
  sessions: 'Sessions', newSession: '+ New', running: 'Running', canvas: 'GeoGebra canvas',
  createOrSelect: 'Create or select a session to begin.', assistant: 'Assistant', settings: 'Settings',
  providerSettings: 'Provider settings', apiKey: 'DeepSeek API Key', savedOnlyHere: 'Saved only in this browser',
  saveOnDevice: 'Save on this device', forget: 'Forget', keySafety: 'The key is encrypted in this browser and is never sent to Session storage or the server database.', keyApplication: 'Get a DeepSeek API Key',
  you: 'You', agent: 'GGB', loadingConversation: 'Loading conversation…', selectConversation: 'Select a session to start a conversation.',
  copyMessage: 'Copy message', copied: 'Copied', copyFailed: 'Could not copy this message. Please try again.',
  about: 'About', close: 'Close', copyrightHolder: 'Li Junqiang and Professor Tan Feng’s team',
  authorsLabel: 'Authors', authors: 'Created by Li Junqiang and Professor Tan Feng’s team',
  licenseNotice: 'Released under the MIT License for mathematics education and research. You may modify it freely under the license terms.',
  email: 'Email', version: 'Version', buildDate: 'Build date',
  placeholder: 'Describe a geometry task… (e.g., draw a circle.)', send: 'Send message', stop: 'Stop task', stopping: 'Stopping task…', stoppingDetail: 'Waiting for the server to cancel this task.',
  onlyCanvas: 'Canvas', algebraView: 'Algebra', casView: 'CAS', viewChangeFailed: 'Could not change canvas views. Please try again.',
  toolSessions: 'Sessions', toolAssistant: 'AI',
  deleteSession: 'Delete local session', deleteConfirm: 'Delete this local session? This cannot remove its server run history.', deleteRunningConfirm: 'This session has a running task. Delete it locally and request that the task stop?', deleteFailed: 'Could not delete this session. Please try again.', deleteWhileWriting: 'The canvas is being updated in another tab. Try deleting this session after the operation finishes.',
  sessionOpenFailed: 'Could not open this session. Please try again.', pendingCanvasTransaction: 'Finish the current canvas operation before switching sessions.',
  runError: 'Run error', keySaved: 'Provider Key is saved in this browser.', keyForgotten: 'Provider Key was removed from this browser.', resumeReadyDetail: 'The key is available. Continue this task when ready.',
  keyRequiredNotice: 'A DeepSeek Key is required. Open Settings to save it in this browser.',
  ready: 'Ready', readyDetail: 'Describe a geometry task to begin.', keyRequired: 'DeepSeek Key required', keyRequiredDetail: 'Open Settings to save a key only in this browser.',
  completed: 'Construction completed', completedDetail: 'GeoGebra execution and validation have finished.', cancelled: 'Task stopped', cancelledDetail: 'The cancellation request was accepted.', attention: 'Run needs attention', failedDetail: 'The server could not complete this run.',
  working: 'Working', workingDetail: 'Building the construction. Elapsed time updates every second.',
  ggbScript: 'GGB script',
  constructionComplete: 'Canvas committed', constructionSteps: 'Construction steps', scriptMissing: '_No GGBScript was generated for display._', statistics: 'Run statistics', elapsed: 'Total time', seconds: 'seconds', tokens: 'Tokens (input + output)', knownTokens: 'Known tokens (input + output)', unknownUsageCalls: 'calls with unknown usage', input: 'input', output: 'output', modelCalls: 'model calls',
} as const

const ZH: Record<UiTextKey, string> = {
  copyRecord: '复制记录', constructionRecord: '构造步骤与修改记录', downloadRecord: '下载记录', constructionDownloadFailed: '无法下载构造记录。',
  buildNotAttempted: '未执行构建', buildStructureRejected: '请求结构被拒绝',
  buildExecutionFailed: '构建执行故障', buildVerificationFailed: '核验失败', lastBuild: '最后一次构建',
  imageReading: '正在读取图片…', attachImage: '添加图片', removeImage: '删除图片', imageOnlyPrompt: '请根据图片中的题目完成几何构图。',
  imageInvalid: '请选择一张有效的 PNG/JPEG 图片，不超过 3 MiB 和 2000 万像素。',
  sessions: '会话', newSession: '+ 新建', running: '运行中', canvas: 'GeoGebra 画布',
  createOrSelect: '新建或选择一个会话以开始。', assistant: '助手', settings: '设置', providerSettings: 'Provider 设置', apiKey: 'DeepSeek API Key', savedOnlyHere: '仅保存在此浏览器中',
  saveOnDevice: '保存在此设备', forget: '忘记此 Key', keySafety: '此 Key 在浏览器内加密保存，不会写入会话存储或服务器数据库。', keyApplication: '申请 DeepSeek API Key',
  you: '你', agent: 'GGB', loadingConversation: '正在加载对话…', selectConversation: '选择一个会话以开始对话。',
  copyMessage: '复制消息', copied: '已复制', copyFailed: '复制失败，请重试。',
  about: '关于', close: '关闭', copyrightHolder: '李均强和谭枫教授团队',
  authorsLabel: '作者', authors: '李均强和谭枫教授团队共同创作',
  licenseNotice: '本工具遵循 MIT License，主要用于数学教育与科研，可按许可条款自由修改。',
  email: '电子邮箱', version: '版本号', buildDate: '构建日期',
  placeholder: '描述一个几何任务…（例如，画一个圆。）', send: '发送消息', stop: '停止任务', stopping: '正在停止任务…', stoppingDetail: '正在等待服务器停止本次任务。',
  onlyCanvas: '仅画布', algebraView: '代数区', casView: 'CAS', viewChangeFailed: '无法切换画布视图，请重试。',
  toolSessions: '会话', toolAssistant: '助手',
  deleteSession: '删除本地会话', deleteConfirm: '删除此本地会话？这不会删除服务器上的运行历史。', deleteRunningConfirm: '此会话仍有运行中的任务。要删除本地会话并请求停止任务吗？', deleteFailed: '无法删除此会话，请重试。', deleteWhileWriting: '另一标签页正在更新画布，请等待本次操作结束后再删除会话。',
  sessionOpenFailed: '无法打开此会话，请重试。', pendingCanvasTransaction: '当前画布操作尚未完成，请先完成后再切换会话。',
  runError: '运行错误', keySaved: 'Provider Key 已保存在此浏览器中。', keyForgotten: 'Provider Key 已从此浏览器移除。', resumeReadyDetail: 'Key 已就绪，点击继续以接着完成本轮任务。',
  keyRequiredNotice: '需要 DeepSeek Key。请在设置中保存到此浏览器。',
  ready: '准备就绪', readyDetail: '描述一个几何任务以开始。', keyRequired: '需要 DeepSeek Key', keyRequiredDetail: '请在设置中仅保存到此浏览器。',
  completed: '构图已完成', completedDetail: 'GeoGebra 执行和校验已完成。', cancelled: '任务已停止', cancelledDetail: '停止请求已提交，任务不会再继续执行。', attention: '运行需要处理', failedDetail: '服务器未能完成本次运行。',
  working: '正在构图', workingDetail: '正在构图，耗时每秒更新。',
  ggbScript: 'GGB 脚本',
  constructionComplete: '画布已提交', constructionSteps: '作图步骤', scriptMissing: '_没有生成可展示的 GGBScript。_', statistics: '本轮统计', elapsed: '总耗时', seconds: '秒', tokens: 'Token（输入+输出）', knownTokens: '已知 Token（输入+输出）', unknownUsageCalls: '次调用用量未知', input: '输入', output: '输出', modelCalls: '模型调用',
}

export function localeFromBrowser(languages: readonly string[] = navigator.languages): PresentationLocale {
  return languages[0]?.toLowerCase().startsWith('zh') === true ? 'zh-CN' : 'en'
}

export function text(locale: PresentationLocale, key: UiTextKey): string {
  return (locale === 'zh-CN' ? ZH : EN)[key]
}

export function defaultSessionTitle(locale: PresentationLocale): string {
  return locale === 'zh-CN' ? '新会话' : 'New session'
}
