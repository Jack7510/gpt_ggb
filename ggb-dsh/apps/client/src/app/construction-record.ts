import { defineComponent, h, ref, type PropType } from 'vue'
import type { PluginCoreConstructionRecord, PresentationLocale } from '@ggb-copilot/application/browser'
import { text } from './localization.js'
import { copyConstructionRecord, downloadConstructionRecord } from './construction-actions.js'

/** Text children are escaped by Vue. Never interpret construction source as HTML. */
export const ConstructionRecord = defineComponent({
  name: 'ConstructionRecord',
  props: {
    report: { type: Object as PropType<PluginCoreConstructionRecord>, required: true },
    locale: { type: String as PropType<PresentationLocale>, required: true },
  },
  setup(props) {
    const feedback = ref('')
    const copy = async (): Promise<void> => {
      try { await copyConstructionRecord(props.report); feedback.value = text(props.locale, 'copied') }
      catch { feedback.value = text(props.locale, 'copyFailed') }
    }
    const download = (): void => {
      try { downloadConstructionRecord(props.report); feedback.value = '' }
      catch { feedback.value = text(props.locale, 'constructionDownloadFailed') }
    }
    return () => h('details', { class: 'construction-record', 'data-test': 'construction-record', open: true }, [
      h('summary', text(props.locale, 'constructionRecord')),
      h('div', { class: 'construction-actions' }, [
        h('button', { type: 'button', 'data-test': 'copy-construction', onClick: copy }, text(props.locale, 'copyRecord')),
        h('button', { type: 'button', 'data-test': 'download-construction', onClick: download }, text(props.locale, 'downloadRecord')),
        h('span', { role: 'status' }, feedback.value),
      ]),
      h('p', { class: 'construction-note' }, text(props.locale, 'constructionScopeNote')),
      h('pre', [h('code', props.report.text)]),
    ])
  },
})
